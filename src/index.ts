import { config } from 'dotenv';
import Eris, { WebhookPayload } from 'eris';
import { appendFileSync, mkdirSync, utimesSync, writeFile, writeFileSync } from 'fs';
import nodeCron from 'node-cron';
import pg from 'pg';

const previousDataFile = './current-data.json';

// INF-654: monit signalling. This service ran BROKEN for over a month -- every
// query failing, 288 times a day -- and nothing noticed, because the only trace
// was console output going to the journal and nobody watches a journal for an
// absence. A `check process` would not have helped either: the process was up
// and healthy the whole time, dutifully failing.
//
// So report the two things a watcher can act on:
//   - lastSuccessFile is touched ONLY after a cycle completes end to end, and is
//     watched for STALENESS. A run that dies anywhere leaves it untouched.
//   - errorLogFile is appended ONLY on failure, and is watched for a CHANGED
//     timestamp, so the first failure is reported immediately rather than after
//     the staleness window.
//
// Deliberately NOT under /tmp or /var/tmp: monit on biserver runs with
// PrivateTmp=yes, which gives it its own /tmp and /var/tmp, so a marker written
// there is invisible to it (INF-615 hit exactly that).
const statusDir = process.env.STATUS_DIR || '/var/log/data-integrity-alerter';
const lastSuccessFile = `${statusDir}/last_success`;
const errorLogFile = `${statusDir}/error.log`;

// A reporting channel that cannot report is as silent as the bug it replaces, so
// every write is guarded and says so on the console if it fails. A failure to
// write the marker still surfaces: the marker goes stale and monit says so.
const recordSuccess = () => {
	try {
		writeFileSync(lastSuccessFile, '');
	} catch (err) {
		console.error(`could not write ${lastSuccessFile}: ${err}`);
	}
};

const recordFailure = (stage: string, err: unknown) => {
	const line = `[${new Date().toISOString()}] ${stage}: ${err}\n`;
	try {
		appendFileSync(errorLogFile, line);
	} catch (writeErr) {
		console.error(`could not append to ${errorLogFile}: ${writeErr}`);
	}
};

// Pre-create both so monit can always stat them and baseline their timestamps.
// The success marker is backdated to the epoch when it does not exist, so its
// staleness check fires until the first REAL success rather than reporting a
// brand-new install as healthy.
try {
	mkdirSync(statusDir, { recursive: true });
	writeFileSync(errorLogFile, '', { flag: 'a' });
	// `wx` throws EEXIST if the marker is already there, which is what keeps the
	// backdate below from resetting a real success on every restart.
	writeFileSync(lastSuccessFile, '', { flag: 'wx' });
	// ONLY reached when the marker was just created. Without this the marker
	// carries the time of THIS startup, so a service that has never completed a
	// single cycle looks healthy to monit until the staleness window elapses --
	// and on a restart loop it would look healthy forever. A green check over an
	// unverified state is the failure mode this whole marker exists to prevent.
	utimesSync(lastSuccessFile, 0, 0);
} catch (err) {
	if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
		console.error(`could not initialise ${statusDir}: ${err}`);
	}
}

// Load environment variables from any .env file that exists
config();

console.log('initializing DB connections...');

const db = new pg.Pool({
	user: process.env.DB_USER,
	host: process.env.DB_HOST,
	database: process.env.DB_DATABASE,
	password: process.env.DB_PASSWORD,
	port: parseInt(process.env.DB_PORT || '5432', 10),
	// iDempiere keeps its tables in the `adempiere` schema, and the role we
	// connect as has no search_path of its own -- so it falls back to the
	// default `"$user", public`, neither of which holds ad_client. Every query
	// below then dies in the PARSER with 42P01 before it reaches the planner.
	//
	// Setting the path on the connection rather than schema-qualifying each
	// table covers all five tables in the query below, and every query added
	// after this one. `public` is kept on the path so anything provided by an
	// extension still resolves.
	options: `-c search_path=${process.env.DB_SCHEMA || 'adempiere'},public`,
});

db.on('error', (err) => {
	console.log('pg error: ' + err);
});

const businessPartnersWithoutLocationQuery = `
SELECT
	bp.c_bpartner_uu,
	c.name  AS client_name,
	bp.name AS bp_name
FROM
	ad_client c
		JOIN c_bpartner bp
			ON c.ad_client_id = bp.ad_client_id AND bp.created < (NOW() - '10 seconds'::interval)
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
				// Remove ones not present in the returned data (i.e. have been fixed)
				data.businessPartnerUUs = data.businessPartnerUUs.filter((uu) =>
					dbBusinessPartnerUUs.includes(uu)
				);
				// Filter out the BPs we've already logged
				const currentBusinessPartnersToLog = results.rows.filter(
					(row) => !data.businessPartnerUUs.includes(row.c_bpartner_uu)
				);
				if (currentBusinessPartnersToLog.length) {
					console.log(
						currentBusinessPartnersToLog.length + ' new results returned'
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
					recordFailure('write ' + previousDataFile, err);
					return;
				}
				// Only here: query ran, results were processed, state persisted.
				recordSuccess();
			});
		})
		.catch((exception) => {
			console.error(exception);
			recordFailure('DB query', exception);
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
	recordFailure('uncaught exception', `${err} (origin: ${origin})`);
	db.end();
	process.exit(1);
});
