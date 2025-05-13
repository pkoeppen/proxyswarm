import "dotenv/config";
import fs from "fs";

import { awsProxyManager } from "./aws";
import { ProxySwarm } from "./swarm";

const runningProxies = await awsProxyManager.listProxies();
const proxies = runningProxies.length > 0 ? runningProxies : await awsProxyManager.startProxies(5);

const lines = fs
  .readFileSync("../wordbook/scripts/etym/etymonline_word_urls.txt", "utf-8")
  .trim()
  .split("\n");

const swarm = await ProxySwarm.create(
  {
    proxies: proxies,
  },
  {
    username: "username",
    password: "password",
    port: 8081,
  },
);

await swarm.run(
  lines,
  async (res) => {
    const body = await res.text();
  },
  async (url, error) => {
    //console.error(url, error);
  },
);
