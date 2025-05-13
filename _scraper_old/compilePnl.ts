import "dotenv/config";

import { Scraper } from ".";
import { ProxyPool } from "./proxy";

const proxyPool = new ProxyPool();
const scraper = await Scraper.create({ proxyPool });

await scraper.compilePartsAndLabor();
