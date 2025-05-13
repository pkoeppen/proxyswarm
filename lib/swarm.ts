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
    const agent = new HttpsProxyAgent(url);
    this.agent = agent;
  }
}

interface SwarmConfig {
  proxies: string[];
}

export class ProxySwarm {
  proxies: string[];
  proxyConfig: Omit<ProxyConfig, "host">;
  headers: { [key: string]: string } = {};
  private readonly PING_INTERVAL_MS = 1000;

  private constructor(config: SwarmConfig, proxyConfig: Omit<ProxyConfig, "host">) {
    if (!config.proxies.length) {
      console.error(`Error: No proxies provided in proxy array`.red);
    }
    this.proxies = config.proxies;
    this.proxyConfig = proxyConfig;
    this.setHeaders();
  }

  setHeaders() {
    this.headers["Accept"] = "application/json, text/plain, */*";
    this.headers["Accept-Encoding"] = "gzip, deflate, br";
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

  static async create(
    config: SwarmConfig,
    proxyConfig: Omit<ProxyConfig, "host">,
  ): Promise<ProxySwarm> {
    const instance = new ProxySwarm(config, proxyConfig);
    await instance.waitForProxiesReady();
    return instance;
  }

  /**
   * Wait for proxies to be ready
   * @param instanceIds Array of instance IDs to wait for
   */
  private async waitForProxiesReady(): Promise<void> {
    console.log(`Waiting for proxies to be ready...`);
    const running = new Set<string>();
    while (running.size < this.proxies.length) {
      await Promise.all(
        this.proxies.map(async (proxy) => {
          if (running.has(proxy)) {
            return;
          }
          try {
            await fetch(`http://${proxy}:${this.proxyConfig.port}/`);
            console.log(` ${proxy} is ready`.green);
            running.add(proxy);
          } catch (error) {
            // ECONNREFUSED
          }
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, this.PING_INTERVAL_MS));
    }
  }

  async run(
    urls: string[],
    handler: (res: Response) => Promise<void>,
    errorHandler?: (url: string, error: unknown) => Promise<void>,
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

    // TODO: Implement parallel requests rather than batches

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
            await errorHandler?.(url, error);
          } finally {
            clearTimeout(timeout);
          }

          const { elapsed, eta, remaining } = timer.tick(itemStartTime, proxies.length);

          const proxyHostname = proxy.agent.proxy.hostname;
          const trimmedUrl = url.length > 44 ? url.slice(0, 44) + "..." : url;
          const infoStr = [
            trimmedUrl.padEnd(48, " "),
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

    console.log("Done".green);
  }
}
