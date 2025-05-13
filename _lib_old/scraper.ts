import "colors";
import "dotenv/config";
import { HttpsProxyAgent } from "https-proxy-agent";
import _ from "lodash";
import fetch, { RequestInit, Response } from "node-fetch";

interface EMAConfig {
  alpha: number;
  ema: number;
  startTime: number;
  totalItems: number;
  itemsProcessed: number;
}

class Timer {
  config: EMAConfig;

  constructor(config: EMAConfig) {
    this.config = config;
  }

  tick(itemStartTime: number, scaleFactor = 1) {
    this.config.itemsProcessed++;

    const itemElapsedTime = Date.now() - itemStartTime;

    this.config.ema =
      this.config.ema === 0
        ? itemElapsedTime
        : this.config.alpha * itemElapsedTime + (1 - this.config.alpha) * this.config.ema;

    // Estimate remaining time.
    const remainingItems = this.config.totalItems - this.config.itemsProcessed;
    const eta = (this.config.ema * remainingItems) / scaleFactor; // scaleFactor represents the number of proxies running simultaneously.
    const elapsed = Date.now() - this.config.startTime;
    const etaDisplay = this.formatETA(eta);
    const elapsedDisplay = new Date(elapsed).toISOString().slice(11, 19);
    const remainingDisplay =
      `${this.config.itemsProcessed.toString().padStart(this.config.totalItems.toString().length, " ")}` +
      `/${this.config.totalItems}`;

    return { elapsed: elapsedDisplay, eta: etaDisplay, remaining: remainingDisplay };
  }

  formatETA(time: number) {
    let delta = Math.abs(time) / 1000;

    const days = Math.floor(delta / 86400);
    delta -= days * 86400;

    const hours = Math.floor(delta / 3600) % 24;
    delta -= hours * 3600;

    const minutes = Math.floor(delta / 60) % 60;
    delta -= minutes * 60;

    const seconds = Math.round(delta % 60);

    return [
      days.toString().padStart(3, "0"),
      hours.toString().padStart(2, "0"),
      minutes.toString().padStart(2, "0"),
      seconds.toString().padStart(2, "0"),
    ].join(":");
  }
}

interface ProxyConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

class Proxy {
  agent: HttpsProxyAgent<string>;

  constructor(config: ProxyConfig) {
    const url = `http://${config.username}:${config.password}@${config.host}:${config.port}`;
    console.log(url);
    const agent = new HttpsProxyAgent(url);
    this.agent = agent;
  }
}

interface SwarmConfig {
  proxies: string[];
}

export class ProxySwarm {
  proxies: SwarmConfig["proxies"];
  proxyConfig: Omit<ProxyConfig, "host">;
  headers: { [key: string]: string } = {};

  constructor(config: SwarmConfig, proxyConfig: Omit<ProxyConfig, "host">) {
    if (!config.proxies.length) {
      console.error(`Error: No proxies provided in proxy array.`.red);
    }
    this.proxies = config.proxies;
    this.proxyConfig = proxyConfig;
    this.setHeaders();
  }

  setHeaders() {
    this.headers["Accept"] = "application/json, text/plain, */*";
    this.headers["Accept-Encoding"] = "gzip, deflate, br, zstd";
    this.headers["Accept-Language"] = "en-US,en;q=0.9";
    this.headers["Connection"] = "keep-alive";
    this.headers["Content-Type"] = "application/json";
    // this.headers["Origin"] = this.baseUrl;
    // this.headers["Referer"] = this.baseUrl;
    this.headers["sec-fetch-dest"] = "empty";
    this.headers["sec-fetch-mode"] = "cors";
    this.headers["sec-fetch-site"] = "same-origin";
    this.headers["sec-ch-ua"] = '"Chromium";v="130", "Google Chrome";v="130"';
    this.headers["sec-ch-ua-mobile"] = "?0";
    this.headers["sec-ch-ua-platform"] = '"macOS"';
    this.headers["User-Agent"] =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  }

  async run(
    urls: string[],
    handler: (res: Response) => Promise<void>,
    errorHandler: (error: unknown) => Promise<void>,
  ) {
    const timer = new Timer({
      alpha: 0.18,
      ema: 0,
      startTime: Date.now(),
      totalItems: urls.length,
      itemsProcessed: 0,
    });

    const proxies = await Promise.all(
      this.proxies.map((proxy) => new Proxy({ host: proxy, ...this.proxyConfig })),
    );

    const chunks = _.chunk(urls, proxies.length);

    for (const chunk of chunks) {
      await Promise.all(
        chunk.map(async (url, i) => {
          const proxy = proxies[i];
          const itemStartTime = Date.now();
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const requestConfig: RequestInit = {
            method: "GET",
            headers: this.headers,
            agent: proxy.agent,
            signal: controller.signal,
          };

          let success = false;

          try {
            const res = await fetch(url, requestConfig);
            await handler(res);
            success = true;
          } catch (error) {
            await errorHandler(error);
          } finally {
            clearTimeout(timeout);
          }

          // if (res.status >= 400) {
          //   if (retry && res.status !== 404) {
          //     if (res.status === 403) {
          //       logger.error(`Response: 403. Attempting login and retrying...`);
          //       //await this.login(false);
          //     } else {
          //       logger.error(`Response: ${res.status}. Retrying...`);
          //     }
          //     return this.query(url, requestConfig, false);
          //   } else {
          //     throw new Error(`Response: ${res.status} ${res.statusText}`);
          //   }
          // }

          const { elapsed, eta, remaining } = timer.tick(itemStartTime, proxies.length);

          const proxyHostname = proxy.agent.proxy.hostname;
          const trimmedUrl = url.length > 47 ? url.slice(0, 47) + "..." : url;
          const actionStr = `Processed URL ${trimmedUrl}`;
          const infoStr = [
            actionStr.padEnd(64, " "),
            elapsed,
            eta,
            remaining,
            `proxy: ${proxyHostname}`,
          ].join(" | ");

          if (success) {
            console.log(infoStr);
          } else {
            console.error(infoStr.red);
          }
        }),
      );
    }

    console.log("Done.".green);
    process.exit(0);
  }
}
