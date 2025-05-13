import { HttpsProxyAgent } from "https-proxy-agent";
import fs from "fs";

export class ProxyPool {
  agents: HttpsProxyAgent<string>[] = [];

  constructor() {
    this.#initializeProxies();
  }

  #initializeProxies() {
    const proxyFile = fs.readFileSync("./src/data/scraper/proxies.json", "utf-8");
    const proxies = JSON.parse(proxyFile);

    for (const ipAddress of proxies) {
      const username = process.env.PROXY_USERNAME;
      const password = process.env.PROXY_PASSWORD;
      const port = process.env.PROXY_PORT;
      this.agents.push(new HttpsProxyAgent(`http://${username}:${password}@${ipAddress}:${port}`));
    }
  }
}
