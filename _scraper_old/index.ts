import logger from "@/lib/logger";
import { ExecException, exec } from "child_process";
import * as fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import _ from "lodash";

import { AuthManager } from "./auth";
import { ProxyPool } from "./proxy";

interface ScraperConfig {
  authManager?: AuthManager;
  proxyAgent?: HttpsProxyAgent<string>;
  proxyPool?: ProxyPool;
}

export class Scraper {
  baseUrl: string;
  authManager: AuthManager;
  proxyPool: ProxyPool | undefined;

  startAfter: {
    id: string;
    year: string;
    make: string;
    model: string;
    engine: string;
  } | null = null;

  constructor(config?: ScraperConfig) {
    this.baseUrl = "https://my.alldata.com";
    this.authManager =
      config?.authManager ||
      new AuthManager({ baseUrl: this.baseUrl, proxyAgent: config?.proxyAgent });
    this.proxyPool = config?.proxyPool;
  }

  static async create(config?: ScraperConfig) {
    const scraper = new Scraper(config);
    await scraper.authManager.login();
    return scraper;
  }

  /*
   * Clones the current Scraper instance with the same AuthManager.
   */
  clone(config?: ScraperConfig) {
    const authManager = new AuthManager({
      baseUrl: this.baseUrl,
      headers: this.authManager.headers,
      isAuthenticated: this.authManager.isAuthenticated,
      proxyAgent: config?.proxyAgent || this.authManager.proxyAgent,
    });
    return Scraper.create({ authManager, ...config });
  }

  async login() {
    await this.authManager.login();
  }

  compileVehicles() {
    return new Promise(async (resolve, reject) => {
      const filePath = "./csv/vehicles.csv";
      this.startAfter = this.#getStartAfter(filePath);

      const stream = fs.createWriteStream(filePath, {
        encoding: "utf-8",
        flags: this.startAfter ? "a" : undefined,
      });

      stream.on("finish", resolve);
      stream.on("error", reject);

      if (this.startAfter) {
        logger.verbose("Appending to existing CSV file");
      } else {
        logger.verbose("Creating new CSV file");
        stream.write("id;year;make;model;engine\n");
      }

      const years = await this.#getYears();
      await this.#processYears(years, stream);

      logger.info("All entries processed successfully.");
      process.exit(0);
    });
  }

  #getStartAfter(filePath: string) {
    try {
      const fileContent = fs.readFileSync(filePath, "utf-8");
      const lines = fileContent.trim().split("\n");
      const lastLine = lines.pop();

      if (!lines.length || !lastLine) {
        return null;
      }

      const [id, year, make, model, engine] = lastLine.split(";");

      return { id, year, make, model, engine };
    } catch (_error) {
      return null;
    }
  }

  async #getYears(): Promise<YearData[]> {
    const url = this.baseUrl + "/ADAG/car-lookup/v3/years?has-repair-data=true";
    const res = await this.authManager.query(url);
    const years = res.items.map(({ title, makesLink }: YearData) => ({
      title,
      makesLink,
    }));
    return years;
  }

  async #getMakes(year: YearData): Promise<MakeData[]> {
    const url = this.baseUrl + year.makesLink;
    const res = await this.authManager.query(url);
    const makes = res.items.map(({ title, modelsLink }: MakeData) => ({
      title,
      modelsLink,
    }));
    return makes;
  }

  async #getModels(make: MakeData): Promise<ModelData[]> {
    const url = this.baseUrl + make.modelsLink;
    const res = await this.authManager.query(url);
    const models = res.items.map(({ title, enginesLink }: ModelData) => ({
      title,
      enginesLink,
    }));
    return models;
  }

  async #getEngines(model: ModelData): Promise<EngineData[]> {
    const url = this.baseUrl + model.enginesLink;
    const res = await this.authManager.query(url);
    const engines = res.items.map(({ title, carLink }: EngineData) => ({
      title,
      carLink,
    }));
    return engines;
  }

  async #processYears(years: YearData[], stream: NodeJS.WritableStream) {
    for (const year of years) {
      if (this.startAfter && year.title > this.startAfter.year) {
        logger.verbose(`Skipping year ${year.title}`);
        continue;
      }
      await this.#processMakes(year, stream);
    }
  }

  async #processMakes(year: YearData, stream: NodeJS.WritableStream) {
    let willSkip = !!this.startAfter;
    const makes = await this.#getMakes(year);
    for (const make of makes) {
      if (make.title === this.startAfter?.make) {
        willSkip = false;
      }
      if (willSkip) {
        logger.verbose(`Skipping make ${make.title}`);
        continue;
      }
      await this.#processModels(year, make, stream);
    }
  }

  async #processModels(year: YearData, make: MakeData, stream: NodeJS.WritableStream) {
    let willSkip = !!this.startAfter;
    const models = await this.#getModels(make);
    for (const model of models) {
      if (model.title === this.startAfter?.model) {
        willSkip = false;
      }
      if (willSkip) {
        logger.verbose(`Skipping model ${model.title}`);
        continue;
      }
      await this.#processEngines(year, make, model, stream);
    }
  }

  async #processEngines(
    year: YearData,
    make: MakeData,
    model: ModelData,
    stream: NodeJS.WritableStream,
  ) {
    let willSkip = !!this.startAfter;
    const engines = await this.#getEngines(model);
    for (const engine of engines) {
      if (engine.title === this.startAfter?.engine) {
        willSkip = false;
        this.startAfter = null;
        continue;
      }
      if (willSkip) {
        logger.verbose(`Skipping engine ${engine.title}`);
        continue;
      }
      logger.info(`Writing ${engine.carLink.carDescription}`);
      stream.write(
        [engine.carLink.carId, year.title, make.title, model.title, engine.title].join(";") + "\n",
      );
    }
  }

  async compilePartsAndLaborComponents() {
    return new Promise(async (resolve, reject) => {
      const componentFilePath = "./csv/components.csv";
      const vehicleFilePath = "./csv/vehicles.csv";

      const vehicleFile = fs.readFileSync(vehicleFilePath, "utf-8");
      const vehicleFileLines = vehicleFile.split("\n").slice(1);

      const componentFileExists = fs.existsSync(componentFilePath);

      const stream = fs.createWriteStream(componentFilePath, {
        encoding: "utf-8",
        flags: componentFileExists ? "a" : undefined,
      });

      stream.on("finish", resolve);
      stream.on("error", reject);

      if (componentFileExists) {
        logger.verbose("Appending to existing CSV file");
        await this.spliceVehicleFileLines(vehicleFileLines, componentFilePath);
      } else {
        logger.verbose("Creating new CSV file");
        stream.write("id;title;vehicleId\n");
      }

      for (const line of vehicleFileLines) {
        const [vehicleId] = line.split(";");
        const components = await this.getPartsAndLaborComponents(vehicleId);
        if (components.length) {
          for (const { id, title, vehicleId } of components) {
            logger.info(`Writing component ${title} (${vehicleId})`);
            stream.write([id, title, vehicleId].join(";") + "\n");
          }
        } else {
          logger.verbose(`No components for vehicle ID ${vehicleId}`);
        }
      }

      logger.info("All entries processed successfully.");
      process.exit(0);
    });
  }

  async spliceVehicleFileLines(vehicleFileLines: string[], componentFilePath: string) {
    const lastLine = await new Promise<string>((resolve, reject) =>
      exec(
        `tail -n 1 ${componentFilePath}`,
        (error: ExecException | null, stdout: string, stderr: string) => {
          if (error || stderr) {
            reject(error || stderr);
          } else {
            resolve(stdout);
          }
        },
      ),
    );

    const [, , lastVehicleId] = lastLine.trim().split(";");

    const index = vehicleFileLines.findIndex((line) => {
      const [vehicleId] = line.split(";");
      return vehicleId === lastVehicleId;
    });

    if (index !== -1) {
      // Start after last-processed vehicle.
      vehicleFileLines.splice(0, index + 1);
    }
  }

  async getPartsAndLaborComponents(vehicleId: string) {
    const url = `${this.baseUrl}/ADAG/repair/ADConnect/v5/carids/${vehicleId}/search/*/show_itypes/189`;
    const res = await this.authManager.query(url);
    const components = res._embedded.data.results.map((result: SearchResult) => {
      const href = result._links.self.href;
      const match = href.match(/components\/(\d+)\//);

      const componentId = match?.[1];
      if (!componentId) {
        logger.error(`No component ID match for ${href}`);
      }

      const title = result.display.split(" >> Parts and Labor")[0];
      if (!title) {
        logger.error(`No title found in "${result.display}"`);
      }

      return { id: componentId, title, vehicleId };
    });

    return components;

    // for (const componentId of components) {
    //   const res = await this.query(this.endpoints.partsAndLabor(vehicleId, componentId));
    //   console.log(JSON.stringify(res, null, 2));
    //   process.exit();
    // }
  }

  async compilePartsAndLabor() {
    return new Promise(async (resolve, reject) => {
      const componentFilePath = "./csv/components.csv";
      const partsAndLaborFilePath = "./csv/pnl.csv";

      const componentFile = fs.readFileSync(componentFilePath, "utf-8");
      const componentFileLines = componentFile.split("\n").slice(1);

      const partsAndLaborFileExists = fs.existsSync(partsAndLaborFilePath);

      const stream = fs.createWriteStream(partsAndLaborFilePath, {
        encoding: "utf-8",
        flags: partsAndLaborFileExists ? "a" : undefined,
      });

      stream.on("finish", resolve);
      stream.on("error", reject);

      if (partsAndLaborFileExists) {
        logger.verbose("Appending to existing CSV file");
        await this.#spliceComponentFileLines(componentFileLines, partsAndLaborFilePath);
      } else {
        logger.verbose("Creating new CSV file");
        stream.write("vehicleId;componentId;parts;labors\n");
      }

      // ETA variables.
      const emaConfig = {
        alpha: 0.18,
        ema: 0,
        startTime: Date.now(),
        totalItems: componentFileLines.length,
        itemsProcessed: 0,
      };

      if (this.proxyPool) {
        const scrapers = await Promise.all(
          this.proxyPool.agents.map((proxyAgent) => this.clone({ proxyAgent })),
        );

        const chunks = _.chunk(componentFileLines, scrapers.length);

        for (const chunk of chunks) {
          await Promise.all(
            chunk.map(async (line, i) => {
              const scraper = scrapers[i];
              const itemStartTime = Date.now();

              // Map each line in the chunk to query its PnL endpoint.
              const [componentId, , vehicleId] = line.split(";");

              let parts, labors;

              try {
                const res = await scraper.getPartsAndLabor(vehicleId, componentId);
                parts = res.parts;
                labors = res.labors;
              } catch (_error) {
                // If the request throws an error, log the vehicleId, componentId,
                // and error message to the errors.log file.
                const error = _error as Error;
                const errorData =
                  JSON.stringify({
                    vehicleId,
                    componentId,
                    error: error.message,
                  }) + "\n";

                fs.writeFileSync("./csv/errors.log", errorData, {
                  flag: "a",
                });

                logger.error(error.message);

                return;
              }

              const data =
                [vehicleId, componentId, JSON.stringify(parts), JSON.stringify(labors)].join(";") +
                "\n";

              stream.write(data);

              emaConfig.itemsProcessed++;
              const { elapsed, eta, remaining } = getETAString(
                itemStartTime,
                emaConfig,
                scrapers.length,
              );

              const proxy = scraper.authManager.proxyAgent?.proxy.hostname;
              const actionStr = `Wrote parts and labor for component ${componentId} (${vehicleId})`;
              const infoStr = [
                actionStr.padEnd(50, " "),
                elapsed,
                eta,
                remaining,
                `proxy: ${proxy}`,
              ].join(" | ");

              logger.info(infoStr);
            }),
          );
        }
      }

      logger.info("All entries processed successfully.");
      process.exit(0);
    });

    function formatETA(time: number) {
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

    function getETAString(
      itemStartTime: number,
      emaConfig: {
        totalItems: number;
        itemsProcessed: number;
        startTime: number;
        ema: number;
        alpha: number;
      },
      scaleFactor = 1,
    ) {
      const itemElapsedTime = Date.now() - itemStartTime;
      emaConfig.ema =
        emaConfig.ema === 0
          ? itemElapsedTime
          : emaConfig.alpha * itemElapsedTime + (1 - emaConfig.alpha) * emaConfig.ema;

      // Estimate remaining time.
      const remainingItems = emaConfig.totalItems - emaConfig.itemsProcessed;
      const eta = (emaConfig.ema * remainingItems) / scaleFactor;
      const elapsed = Date.now() - emaConfig.startTime;
      const etaDisplay = formatETA(eta);
      const elapsedDisplay = new Date(elapsed).toISOString().slice(11, 19);
      const remainingDisplay = `${emaConfig.itemsProcessed}/${emaConfig.totalItems}`;

      return { elapsed: elapsedDisplay, eta: etaDisplay, remaining: remainingDisplay };
    }
  }

  async compilePartsAndLaborFullScale() {
    return new Promise(async (resolve, reject) => {
      const componentFilePath = "./csv/components.csv";
      const partsAndLaborFilePath = "./csv/pnl.csv";

      const componentFile = fs.readFileSync(componentFilePath, "utf-8");
      const componentFileLines = componentFile.split("\n").slice(1);

      const partsAndLaborFileExists = fs.existsSync(partsAndLaborFilePath);

      const stream = fs.createWriteStream(partsAndLaborFilePath, {
        encoding: "utf-8",
        flags: partsAndLaborFileExists ? "a" : undefined,
      });

      stream.on("finish", resolve);
      stream.on("error", reject);

      if (partsAndLaborFileExists) {
        logger.verbose("Appending to existing CSV file");
        await this.#spliceComponentFileLines(componentFileLines, partsAndLaborFilePath);
      } else {
        logger.verbose("Creating new CSV file");
        stream.write("vehicleId;componentId;parts;labors\n");
      }

      // ETA variables.
      const emaConfig = {
        alpha: 0.18,
        ema: 0,
        startTime: Date.now(),
        totalItems: componentFileLines.length,
        itemsProcessed: 0,
      };

      if (this.proxyPool) {
        const agents = this.proxyPool.agents;
        const chunkSize = Math.ceil(componentFileLines.length / agents.length);
        const proxyChunks = _.chunk(componentFileLines, chunkSize); // Equal to proxyAgents.length.

        if (agents.length !== proxyChunks.length) {
          throw new Error("Number of proxy agents and line chunks must be equal");
        }

        await Promise.all(
          agents.map(async (proxyAgent, c) => {
            const scraper = await this.clone({ proxyAgent });
            const chunk = proxyChunks[c];

            for (const line of chunk) {
              const itemStartTime = Date.now();

              // Map each line in the chunk to query its PnL endpoint.
              const [componentId, , vehicleId] = line.split(";");
              const { parts, labors } = await scraper.getPartsAndLabor(vehicleId, componentId);

              const data =
                [vehicleId, componentId, JSON.stringify(parts), JSON.stringify(labors)].join(";") +
                "\n";

              stream.write(data);

              emaConfig.itemsProcessed++;
              const { elapsed, eta, remaining } = getETAString(
                itemStartTime,
                emaConfig,
                agents.length,
              );

              const proxy = proxyAgent.proxy.hostname;
              if (proxy === "178.156.131.177") {
                logger.info(
                  [
                    `Wrote parts and labor for component ${componentId} (${vehicleId})`.padEnd(
                      50,
                      " ",
                    ),
                    elapsed,
                    eta,
                    remaining.padStart(emaConfig.totalItems.toString().length * 2 + 1, " "),
                    `(proxy: ${proxy})`,
                  ].join(" | "),
                );
              }
            }
          }),
        );
      }

      logger.info("All entries processed successfully.");
      process.exit(0);
    });

    function formatETA(time: number) {
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

    function getETAString(
      itemStartTime: number,
      emaConfig: {
        totalItems: number;
        itemsProcessed: number;
        startTime: number;
        ema: number;
        alpha: number;
      },
      scaleFactor = 1,
    ) {
      const itemElapsedTime = Date.now() - itemStartTime;
      emaConfig.ema =
        emaConfig.ema === 0
          ? itemElapsedTime
          : emaConfig.alpha * itemElapsedTime + (1 - emaConfig.alpha) * emaConfig.ema;

      // Estimate remaining time.
      const remainingItems = emaConfig.totalItems - emaConfig.itemsProcessed;
      const eta = (emaConfig.ema * remainingItems) / scaleFactor;
      const elapsed = Date.now() - emaConfig.startTime;
      const etaDisplay = formatETA(eta);
      const elapsedDisplay = new Date(elapsed).toISOString().slice(11, 19);
      const remainingDisplay = `${emaConfig.itemsProcessed}/${emaConfig.totalItems}`;

      return { elapsed: elapsedDisplay, eta: etaDisplay, remaining: remainingDisplay };
    }
  }

  async #spliceComponentFileLines(componentFileLines: string[], partsAndLaborFilePath: string) {
    const lastLine = await new Promise<string>((resolve, reject) =>
      exec(
        `tail -n 1 ${partsAndLaborFilePath}`,
        (error: ExecException | null, stdout: string, stderr: string) => {
          if (error || stderr) {
            reject(error || stderr);
          } else {
            resolve(stdout);
          }
        },
      ),
    );

    const [lastVehicleId, lastComponentId] = lastLine.trim().split(";");

    const index = componentFileLines.findIndex((line) => {
      const [componentId, , vehicleId] = line.split(";");
      return componentId === lastComponentId && vehicleId === lastVehicleId;
    });

    if (index !== -1) {
      // Start after last-processed component.
      componentFileLines.splice(0, index + 1);
      logger.verbose(`Starting from vehicle ID ${lastVehicleId}, component ID ${lastComponentId}`);
    } else {
      logger.error(`Last component file index not found`);
      process.exit(1);
    }
  }

  async getPartsAndLabor(vehicleId: string, componentId: string) {
    const url = `${this.baseUrl}/ADAG/repair/ADConnect/v5/carids/${vehicleId}/components/${componentId}/itypes/189/?flatten=true`;
    const res = await this.authManager.query(url);
    const parts = res._embedded.data.partsAndLabor.parts;
    const labors = res._embedded.data.partsAndLabor.labors;

    return { parts, labors };
  }
}
