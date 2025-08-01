import { config } from 'dotenv';
import Eris, { WebhookPayload } from 'eris';
import { writeFile } from 'fs';
import nodeCron from 'node-cron';
import pg from 'pg';

const previousDataFile = './current-data.json';

// Load environment variables from any .env file that exists
config();

console.log('initializing DB connections...');

const db = new pg.Pool({
	user: process.env.DB_USER,
	host: process.env.DB_HOST,
	database: process.env.DB_DATABASE,
	password: process.env.DB_PASSWORD,
	port: parseInt(process.env.DB_PORT || '5432', 10),
});

db.on('error', (err) => {
	console.log('pg error: ' + err);
});

const businessPartnersWithoutLocationQuery = `
SELECT
	bp.c_bpartner_uu,
	c.name   AS client_name,
	bp.name  AS bp_name
FROM
	ad_client c
		JOIN c_bpartner bp
			ON c.ad_client_id = bp.ad_client_id
		LEFT JOIN c_bpartner_location bpl
			ON bp.c_bpartner_id = bpl.c_bpartner_id
		LEFT JOIN c_location l
			ON bpl.c_location_id = l.c_location_id
		JOIN c_bp_group bpg
			ON bp.c_bp_group_id = bpg.c_bp_group_id
WHERE
	c.ad_client_id > 1000000
	AND c.isactive = 'Y'
	AND (bpl.c_bpartner_location_id IS NULL
		OR l.c_location_id IS NULL)
ORDER BY
	bp.created DESC;`;

// Initialize the Discord bot
const discordBot = Eris(process.env.DISCORD_BOT_TOKEN || '', {
	getAllUsers: true,
	intents: ['guildMembers'],
});

// Set up the discord bot
(async () => {
	discordBot.on('ready', () => {
		console.log('Listening for discord events.');
	});
	await discordBot.connect();
	console.log('Discord bot is ready!');
})();

let data: { businessPartnerUUs: string[] } = { businessPartnerUUs: [] };
try {
	const previouslySavedData = require(previousDataFile);
	if (
		typeof previouslySavedData === 'object' &&
		previouslySavedData !== null &&
		!Array.isArray(previouslySavedData)
	) {
		data = previouslySavedData;
	}
	data.businessPartnerUUs ||= [];
} catch {
	console.log('previous data file does not exist');
}

// Perform the Discord notification via webhook
const notifyOnDiscord = (data: WebhookPayload) => {
	try {
		discordBot.executeWebhook(
			process.env.DISCORD_HOOK_ID || '',
			process.env.DISCORD_HOOK_TOKEN || '',
			data
		);
		return true;
	} catch (err) {
		console.log(`Error while forwarding to Discord: ${err}`);
	}
	return false;
};

// This job runs any query(ies) and notifies Discord, if need be
const cronJob = () => {
	console.log('running DB query');
	db.query<{
		c_bpartner_uu: string;
		client_name: string;
		bp_name: string;
	}>(businessPartnersWithoutLocationQuery)
		.then((results) => {
			console.log('analyzing results');
			if ((results.rowCount || 0) > 0) {
				const dbBusinessPartnerUUs = results.rows.map(
					(row) => row.c_bpartner_uu
				);
				// Filter out the BPs we've already logged
				const currentBusinessPartnersToLog = results.rows.filter(
					(row) => !data.businessPartnerUUs.includes(row.c_bpartner_uu)
				);
				if (currentBusinessPartnersToLog.length) {
					console.log(
						currentBusinessPartnersToLog.length + ' new results returned'
					);
					// Remove ones not present in the returned data
					data.businessPartnerUUs = data.businessPartnerUUs.filter(
						(uu) => !dbBusinessPartnerUUs.includes(uu)
					);
					const maxClientNameLength = Math.max(
						'Client'.length,
						...currentBusinessPartnersToLog.map((row) => row.client_name.length)
					);
					const maxBusinessPartnerNameLength = Math.max(
						'Business Partner'.length,
						...currentBusinessPartnersToLog.map((row) => row.bp_name.length)
					);
					const header =
						"hey <@&907930639750266880>, these BPs don't have locations:\n```\n| Client" +
						' '.repeat(maxClientNameLength - 6) +
						' | Business Partner' +
						' '.repeat(maxBusinessPartnerNameLength - 16) +
						' |\n| ------' +
						'-'.repeat(maxClientNameLength - 6) +
						' | ----------------' +
						'-'.repeat(maxBusinessPartnerNameLength - 16) +
						' |';
					let table = header;
					data.businessPartnerUUs = [];
					let loggedBusinessPartnerUUs: string[] = [];
					let didLastDiscordPushFail = false;
					for (let row of currentBusinessPartnersToLog) {
						let newRow =
							'| ' +
							row.client_name +
							' '.repeat(maxClientNameLength - row.client_name.length) +
							' | ' +
							row.bp_name +
							' '.repeat(maxBusinessPartnerNameLength - row.bp_name.length) +
							' |';
						// Don't forget to add 1 for the newline and 4 for the statement close
						if (table.length + newRow.length + 1 + 4 > 2000) {
							// Send the message to Discord
							if (!notifyOnDiscord({ content: table + '\n```' })) {
								didLastDiscordPushFail = true;
								break;
							} else {
								data.businessPartnerUUs.push(...loggedBusinessPartnerUUs);
								loggedBusinessPartnerUUs = [];
							}
							table = header + '\n' + newRow;
						} else {
							table += '\n' + newRow;
						}
						loggedBusinessPartnerUUs.push(row.c_bpartner_uu);
					}
					if (!didLastDiscordPushFail) {
						// Send the final table
						if (notifyOnDiscord({ content: table + '\n```' })) {
							data.businessPartnerUUs.push(...loggedBusinessPartnerUUs);
						}
					}
				} else {
					console.log('no new results returned');
				}
			} else {
				console.log('no results returned');
				data.businessPartnerUUs = [];
			}
			writeFile(previousDataFile, JSON.stringify(data), (err) => {
				if (err) {
					console.error('Error writing file:', err);
				}
			});
		})
		.catch((exception) => {
			console.error(exception);
		});
};

// Run the first check since the next run may not be for another 5 minutes
console.log('executing first check');
cronJob();

// Set the cron job to execute every 5 minutes
console.log('setting cron job');
nodeCron.schedule('*/5 * * * *', cronJob);

// Clean up if the process needs to exit
process.on('uncaughtException', (err, origin) => {
	// Don't exit out on connection resets since the pool should handle it
	if (err.message.includes('Connection reset by peer')) {
		console.log('connection reset by peer, but continuing');
		return;
	}
	console.log(
		process.stderr.fd,
		`Caught exception: ${err}\n` + `Exception origin: ${origin}\n`
	);
	db.end();
	process.exit(1);
});
