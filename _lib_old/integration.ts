import fs from "fs";
import { Response } from "node-fetch";

import { ProxySwarm } from "./scraper";

const port = parseInt(process.env.PORT!);
const username = process.env.USERNAME!;
const password = process.env.PASSWORD!;

const proxies = fs.readFileSync("./.proxies", "utf-8").trim().split("\n");

const swarm = new ProxySwarm({ proxies }, { port, username, password });
const content = fs.readFileSync("../wordbook/lib/scraper/etymonline_word_urls.txt", "utf-8");
const urls = content.trim().split("\n");

const handler = async (res: Response) => {
  const text = await res.text();
  const filename = res.url.split("/").pop() + ".html";
  const outputPath = `output/${filename}`;
  fs.writeFileSync(outputPath, text, "utf-8");
};

const errorHandler = async (error: unknown) => {
  console.error(error.message);
};

await swarm.run(urls, handler, errorHandler);
