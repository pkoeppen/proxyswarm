import logger from "@/lib/logger";
import * as fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import nodeFetch, { RequestInit, Response } from "node-fetch";

interface AuthManagerConfig {
  baseUrl: string;
  headers?: { [key: string]: string };
  isAuthenticated?: boolean | null;
  proxyAgent?: HttpsProxyAgent<string>;
  username: string;
  password: string;
}

export class AuthManager {
  baseUrl: string;
  headers: { [key: string]: string } = {};
  isAuthenticated: boolean | null = null;
  proxyAgent: HttpsProxyAgent<string> | undefined;
  username: string;
  password: string;

  constructor(config: AuthManagerConfig) {
    this.baseUrl = config.baseUrl;
    this.proxyAgent = config.proxyAgent;
    this.username = config.username;
    this.password = config.password;
    this.setHeaders();
  }

  setHeaders() {
    this.headers["Accept"] = "application/json, text/plain, */*";
    this.headers["Accept-Encoding"] = "gzip, deflate, br, zstd";
    this.headers["Accept-Language"] = "en-US,en;q=0.9";
    this.headers["Connection"] = "keep-alive";
    this.headers["Content-Type"] = "application/json";
    this.headers["Origin"] = this.baseUrl;
    this.headers["Referer"] = this.baseUrl;
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

  async login(useCookieFile = true) {
    if (useCookieFile) {
      if (this.isAuthenticated) {
        logger.verbose("Already authenticated");
        return;
      }

      try {
        const cookies = this.#readCookieFile();
        const cookieString = this.#toCookieString(cookies);
        const isValidCookie = await this.#validateCookie(cookieString);

        if (isValidCookie) {
          this.headers["Cookie"] = cookieString;
          this.isAuthenticated = true;
          logger.verbose("Using cookie file");
          return;
        } else {
          logger.verbose("Stale cookie file");
        }
      } catch (error) {
        logger.error((error as Error).message);
      }
    }

    logger.info("Logging in");

    const res = await fetch(this.baseUrl + "/ADAG/sso/login", {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        username: process.env.ALLDATA_USERNAME,
        password: process.env.ALLDATA_PASSWORD,
      }),
    });

    if (res.status === 200) {
      let accessToken = "";
      let accessTokenRefresh = "";

      const setCookies = res.headers.getSetCookie();

      for (const cookie of setCookies) {
        if (cookie.startsWith("Access-Token=")) {
          const token = cookie.split("; ")[0].split("=")[1];
          accessToken = token;
        }
        if (cookie.startsWith("Access-Token-Refresh=")) {
          const token = cookie.split("; ")[0].split("=")[1];
          accessTokenRefresh = token;
        }
      }

      if (!accessToken || !accessTokenRefresh) {
        throw new Error("Failed to extract access tokens");
      }

      const cookies = {
        "Access-Token": accessToken,
        "Access-Token-Refresh": accessTokenRefresh,
      };

      this.headers["Cookie"] = this.#toCookieString(cookies);
      this.isAuthenticated = true;

      this.#writeCookieFile(cookies);
    } else if (res.status >= 400) {
      logger.error(`Error logging in. Response status ${res.status}: ${res.statusText}`);
      process.exit(1);
    }
  }

  #readCookieFile() {
    let cookieFileContent = "";

    try {
      cookieFileContent = fs.readFileSync(".cookie", "utf-8");
    } catch (_error) {
      throw new Error("Missing cookie file");
    }

    if (!cookieFileContent) {
      throw new Error("Empty cookie file");
    }

    return this.#parseCookies(cookieFileContent);
  }

  #writeCookieFile(cookies: { [key: string]: string }) {
    logger.verbose("Writing cookie file");
    fs.writeFileSync(".cookie", JSON.stringify(cookies, null, 2));
  }

  #parseCookies(cookieFileContent: string) {
    try {
      const parsed = JSON.parse(cookieFileContent);
      return parsed;
    } catch (_error) {
      throw new Error("Malformed cookie file");
    }
  }

  #toCookieString(cookies: { [key: string]: string }) {
    const cookieString = Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join(";");
    return cookieString;
  }

  async #validateCookie(cookieString: string) {
    // Make an authorized test request; if it fails, return false.
    const res = await nodeFetch(this.baseUrl + "/ADAG/car-lookup/v3/years?has-repair-data=true", {
      method: "GET",
      headers: { ...this.headers, Cookie: cookieString },
    });
    return res.status === 200;
  }

  async query(url: string, config?: RequestInit, retry = true): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const requestConfig: RequestInit = config || {
      method: "GET",
      headers: this.headers,
      agent: this.proxyAgent,
      signal: controller.signal,
    };

    if (this.proxyAgent) {
      const hostname = this.proxyAgent.proxy.hostname;
      logger.debug(`Querying ${url} (proxy: ${hostname})`);
    } else {
      logger.debug(`Querying ${url}`);
    }

    let res: Response;
    try {
      res = await nodeFetch(url, requestConfig);
    } catch (error) {
      if (retry) {
        // Probably a request timeout error.
        return this.query(url, requestConfig, false);
      } else {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (res.status >= 400) {
      if (retry && res.status !== 404) {
        if (res.status === 403) {
          logger.error(`Response: 403. Attempting login and retrying...`);
          await this.login(false);
        } else {
          logger.error(`Response: ${res.status}. Retrying...`);
        }
        return this.query(url, requestConfig, false);
      } else {
        throw new Error(`Response: ${res.status} ${res.statusText}`);
      }
    }

    return res.json();
  }
}
