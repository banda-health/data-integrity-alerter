import Eris from "eris";
import pg from "pg";

console.log("initializing DB connections...");

const db = new pg.Pool({
  user: process.env.GRAFANA_USER,
  host: process.env.GRAFANA_HOST,
  database: process.env.GRAFANA_DATABASE,
  password: process.env.GRAFANA_PASSWORD,
  port: parseInt(process.env.GRAFANA_DB_PORT || "5432", 10),
});
const queryString = `select bp.c_bpartner_uu, c.name, bp.name, bpg.name, bp.created, bpl.name, l.address1
from ad_client c
	join c_bpartner bp on c.ad_client_id = bp.ad_client_id
	left join c_bpartner_location bpl on bp.c_bpartner_id = bpl.c_bpartner_id
	left join c_location l on bpl.c_location_id = l.c_location_id
	join c_bp_group bpg on bp.c_bp_group_id = bpg.c_bp_group_id
where c.ad_client_id > 1000000
	and c.isactive = 'Y'
	and (bpl.c_bpartner_location_id is null
	or l.c_location_id is null)
order by bp.created`;

const businessParterInformation = async () => {
  try {
    const results = await db.query(queryString);
    console.log(results);
  } catch (error) {
    console.log(error);
  }
};
const bot = Eris(process.env.BOT_TOKEN || "", {
    intents: 0
});
bot.on("ready", () => {
  console.log("Ready!");
});
bot.on("messageCreate", (msg) => {
  if (msg.content === "!ping") {
    bot.createMessage(msg.channel.id, "Pong!");
  }
});
bot.connect();
