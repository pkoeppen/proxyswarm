import logger from "@/lib/logger";
import cliProgress from "cli-progress";
import { sql } from "kysely";
import _ from "lodash";
import pg from "pg";
import fs from "fs";
import readline from "readline";
import { db } from "@/lib/postgres";
import { NewComponent, NewVehicle } from "@/lib/types";
import "colors";

async function loadVehicleData () {
  const vehicleFilePath = "./csv/vehicles.csv";
  const vehicleFile = fs.readFileSync(vehicleFilePath, "utf-8");
  const vehicleFileLines = vehicleFile.trim().split("\n").slice(1);

  const csvDelimiter = ";";
  const allValues = vehicleFileLines.map((line) => {
    const [id, year, make, model, engine] = line.split(csvDelimiter);

    const newVehicle: NewVehicle = {
      alldata_id: parseInt(id),
      year: parseInt(year),
      make,
      model,
      engine,
    };

    return newVehicle;
  });

  const chunks = _.chunk(allValues, 10000);
  for (const values of chunks) {
    await db.insertInto("vehicle").values(values).execute();
  }
}

async function countLines(filePath: string) {
  logger.info(`Calculating line count for ${filePath}`);

  const ASCII_CODE_NEWLINE = 10;

  return new Promise<number>((resolve, reject) => {
    let lineCount = 0;
    const readStream = fs.createReadStream(filePath);

    readStream.on("data", (chunk) => {
      // Count the number of newlines in the file.
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === ASCII_CODE_NEWLINE) {
          lineCount++;
        }
      }
    });

    readStream.on("end", () => resolve(lineCount));
    readStream.on("error", (error) => reject(error));
  });
}

async function loadComponentData() {
  const componentFilePath = "./csv/components.csv";
  const totalLines = await countLines(componentFilePath);
  const readStream = fs.createReadStream(componentFilePath, "utf-8");
  const lines = readline.createInterface({ input: readStream, crlfDelay: Infinity });

  let totalLinesProcessed = 0;

  const progressBar = new cliProgress.SingleBar(
    {
      format: "progress [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} | {action}",
    },
    cliProgress.Presets.shades_classic,
  );
  progressBar.start(totalLines, 0, { action: "Initializing" });

  const maxBatchSize = PG_MAX_PARAMETERS / 6; // '6' represents the number of component table columns.
  let currentBatch = [];
  let batchNumber = 1;

  for await (const line of lines) {
    if (line.startsWith("id;")) {
      // Skip the column title line(s).
      totalLinesProcessed++;
      continue;
    }

    const [componentId, title, vehicleId] = line.split(";");

    const newComponent: NewComponent = {
      vehicle_id: 1, // TODO
      alldata_vehicle_id: parseInt(vehicleId),
      alldata_id: parseInt(componentId),
      title,
      parts: [],
      labors: [],
    };

    currentBatch.push(newComponent);

    if (currentBatch.length >= maxBatchSize) {
      progressBar.update(totalLinesProcessed + 1, {
        action: `Processing batch ${batchNumber++}`,
      });

      await db.insertInto("component").values(currentBatch).execute();

      currentBatch = [];
    }

    totalLinesProcessed++;
  }

  // Process last batch.
  progressBar.update(totalLinesProcessed, {
    action: `Processing batch ${batchNumber++}`,
  });

  await db.insertInto("component").values(currentBatch).execute();

  progressBar.stop();

  // stream.on("data", (data) => {
  //   //
  // });
  // stream.on("finish", resolve);
  // stream.on("error", reject);
}

async function loadPartsAndLaborData() {
  const pnlFilePath = "./csv/pnl.csv";
  const totalLines = 14706152; //await countLines(pnlFilePath);
  const readStream = fs.createReadStream(pnlFilePath, "utf-8");
  const lines = readline.createInterface({ input: readStream, crlfDelay: Infinity });

  const progressBar = new cliProgress.SingleBar(
    {
      format: "progress [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} | {action}",
    },
    cliProgress.Presets.shades_classic,
  );
  progressBar.start(totalLines, 0, { action: "Initializing" });

  let currentLine = 1;
  let currentBatch = 1;

  let batch: {
    vehicleId: string;
    componentId: string;
    parts: string;
    labors: string;
  }[] = [];

  for await (const line of lines) {
    if (line.startsWith("vehicleId;")) {
      // Skip the column title line(s).
      currentLine++;
      continue;
    }

    // if (currentLine % 1000 === 0 || currentLine === totalLines) {
    //   progressBar.update(currentLine, {
    //     action: `Processing line ${currentLine}`,
    //   });
    // }

    const semiColonReplaced = line.trim().replace(/(?<!(^\d+|^\d+;\d+));(?!\{|$)/g, "-");
    const columns = semiColonReplaced.split(";");

    if (columns.length !== 4) {
      // Write faulty line to an error log file.
      console.error(line.red);
    }

    const [vehicleId, componentId, parts, labors] = columns;

    let partsJSON = null;
    let laborsJSON = null;

    if (parts !== "") {
      try {
        partsJSON = JSON.parse(parts);
      } catch (error) {
        console.error((error as Error).message.red);
        console.error(line);
        return;
      }
    }

    if (labors !== "") {
      try {
        laborsJSON = JSON.parse(labors);
      } catch (error) {
        logger.error((error as Error).message.red);
        console.error(line);
        return;
      }
    }

    batch.push({
      vehicleId,
      componentId,
      parts,
      labors,
    });

    if (batch.length >= 10000) {
      progressBar.update(currentLine, {
        action: `Processing batch ${currentBatch}`,
      });

      const vehicleIdArr = batch.map(({ vehicleId }) => `${vehicleId}`);
      const componentIdArr = batch.map(({ componentId }) => `${componentId}`);

      const partsArr = batch
        .map(({ parts }) => (parts ? pg.escapeLiteral(parts) : "null"))
        .join(",");
      const laborsArr = batch
        .map(({ labors }) => (labors ? pg.escapeLiteral(labors) : "null"))
        .join(",");

      const sqlStr = `
          UPDATE component
          SET parts = data.parts, labors = data.labors
          FROM (SELECT UNNEST(ARRAY[${vehicleIdArr}]) AS vehicle_id,
                       UNNEST(ARRAY[${componentIdArr}]) AS component_id,
                       UNNEST(ARRAY[${partsArr}]::JSON[]) AS parts,
                       UNNEST(ARRAY[${laborsArr}]::JSON[]) AS labors
          ) AS data
          WHERE component.alldata_vehicle_id = data.vehicle_id AND
                component.alldata_id = data.component_id;
        `;

      try {
        await sql.raw(sqlStr).execute(db);
      } catch (error) {
        fs.writeFileSync("deleteme.sql", sqlStr, { encoding: "utf-8" });
        throw error;
      }

      batch = [];
      currentBatch++;
    }

    currentLine++;

    // await db
    //   .updateTable("component")
    //   .set({ parts: partsJSON, labors: laborsJSON })
    //   .where("alldata_vehicle_id", "=", vehicleId)
    //   .where("alldata_id", "=", componentId)
    //   .execute();
  }

  // stream.on("data", (data) => {
  //   //
  // });
  // stream.on("finish", resolve);
  // stream.on("error", reject);
}

async function rewriteDelimiter() {
  const pnlFilePath = "./csv/pnl_old.csv";
  const combinedCSVPath = "./csv/combined.csv";
  const totalLines = 14706152; //await countLines(pnlFilePath);
  const readStream = fs.createReadStream(pnlFilePath, "utf-8");
  const writeStream = fs.createWriteStream(combinedCSVPath);
  const lines = readline.createInterface({ input: readStream, crlfDelay: Infinity });

  const progressBar = new cliProgress.SingleBar(
    {
      format: "progress [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} | {action}",
    },
    cliProgress.Presets.shades_classic,
  );

  progressBar.start(totalLines, 0, { action: "Initializing" });

  let currentLine = 1;

  const header = ["alldata_id", "alldata_vehicle_id", "parts", "labors"].join("|") + "\n";
  writeStream.write(header);

  for await (const line of lines) {
    if (line.startsWith("vehicleId;")) {
      // Skip the column title line(s).
      currentLine++;
      continue;
    }

    if (currentLine % 1000 === 0 || currentLine === totalLines) {
      progressBar.update(currentLine, {
        action: `Processing line ${currentLine}`,
      });
    }

    const semiColonReplaced = line.trim().replace(/(?<!(^\d+|^\d+;\d+));(?!\{|$)/g, "-");
    const columns = semiColonReplaced.split(";");

    if (columns.length !== 4 || line.indexOf("|") !== -1) {
      console.error(line.red);
    }

    const [vehicleId, componentId, parts, labors] = columns;

    const content = [componentId, vehicleId, parts, labors].join("|") + "\n";
    writeStream.write(content);

    currentLine++;
  }
}

async function createCombinedComponentCSV() {
  const pnlFilePath = "./csv/pnl.csv";
  const combinedCSVPath = "./csv/combined.csv";
  const totalLines = 14706152; //await countLines(pnlFilePath);
  const readStream = fs.createReadStream(pnlFilePath, "utf-8");
  const writeStream = fs.createWriteStream(combinedCSVPath);
  const lines = readline.createInterface({ input: readStream, crlfDelay: Infinity });

  const progressBar = new cliProgress.SingleBar(
    {
      format: "progress [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} | {action}",
    },
    cliProgress.Presets.shades_classic,
  );

  progressBar.start(totalLines, 0, { action: "Initializing" });

  let currentLine = 1;
  let currentBatch = 1;

  const header = ["alldata_id", "alldata_vehicle_id", "title", "parts", "labors"].join("|");
  //writeStream.write(header);

  let batch = [];

  for await (const line of lines) {
    if (line.startsWith("alldata_id")) {
      // Skip the column title line(s).
      currentLine++;
      continue;
    }

    // if (currentLine % 1000 === 0 || currentLine === totalLines) {
    //   progressBar.update(currentLine, {
    //     action: `Processing line ${currentLine}`,
    //   });
    // }

    const columns = line.split("|");

    if (columns.length !== 4) {
      console.error(line.red);
    }

    const [componentId, vehicleId, parts, labors] = columns;

    batch.push({ vehicleId, componentId, parts, labors });

    if (batch.length === 10000) {
      progressBar.update(currentLine, {
        action: `Processing batch ${currentBatch++}`,
      });
      const componentIds = [];
      const vehicleIds = [];

      for (const { componentId, vehicleId } of batch) {
        componentIds.push(parseInt(componentId));
        vehicleIds.push(parseInt(vehicleId));
      }

      const components = await db
        .selectFrom("component")
        .selectAll()
        .where("alldata_id", "in", componentIds)
        .where("alldata_vehicle_id", "in", vehicleIds)
        .execute();

      console.log(components[0]);

      for (const component of components) {
        const a = batch.find(
          (b) =>
            b.vehicleId === component.alldata_vehicle_id.toString() &&
            b.componentId === component.alldata_id.toString(),
        );

        if (!a) console.log("not found");
      }

      const content = [componentId, vehicleId, parts, labors].join("|") + "\n";
      //writeStream.write(content);

      batch = [];
    }

    currentLine++;
  }
}

async function handler() {
  const pnlFilePath = "./csv/pnl.csv";
  const combinedCSVPath = "./csv/combined.csv";
  const totalLines = 14706152; //await countLines(pnlFilePath);

  const batchSize = 500000;
  const batchCount = Math.ceil(totalLines / batchSize);

  const multibar = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      format: `progress {range} [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} | {action}`,
    },
    cliProgress.Presets.shades_classic,
  );

  const promises = Array.from({ length: batchCount }).map((o, i) => {
    const start = i * batchSize;
    const count = Math.min(batchSize, totalLines - start);
    const bar = multibar.create(count, 0, {
      range: `(${start}-${start + count - 1})`.padEnd(19, " "),
      action: "Initializing...",
    });
    return processSegment(start, batchSize, bar);
  });

  await Promise.all(promises);
}

async function processSegment(start: number, size: number, bar: cliProgress.Bar) {
  const pnlFilePath = "./csv/pnl.csv";
  const combinedCSVPath = "./csv/combined.csv";
  const totalLines = 14706152; //await countLines(pnlFilePath);
  const readStream = fs.createReadStream(pnlFilePath, "utf-8");
  //const writeStream = fs.createWriteStream(combinedCSVPath);
  const lines = readline.createInterface({ input: readStream, crlfDelay: Infinity });

  let i = 0; // Index
  let p = 0; // Processed count

  for await (const line of lines) {
    i++;
    if (i < start) {
      bar.update(p, {
        action: `Skipping line ${i}`,
      });
    } else if (p === size) {
      bar.update(p, {
        action: `Done`,
      });
      break;
    } else {
      bar.update(p, {
        action: `Processing line ${i}`,
      });
      p++;
    }
  }
}

async function idk() {
  const pnlFilePath = "./csv/pnl_old.csv";
  const totalLines = 14706152; //await countLines(pnlFilePath);
  const readStream = fs.createReadStream(pnlFilePath, "utf-8");
  const lines = readline.createInterface({ input: readStream, crlfDelay: Infinity });

  const progressBar = new cliProgress.SingleBar(
    {
      format: "progress [{bar}] {percentage}% | ETA: {eta}s | {value}/{total} | {action}",
    },
    cliProgress.Presets.shades_classic,
  );

  progressBar.start(totalLines, 0, { action: "Initializing..." });

  let currentLine = 1;
  let currentBatch = 1;

  let batch: {
    vehicleId: string;
    componentId: string;
    parts: string;
    labors: string;
  }[] = [];

  const processBatch = async () => {
    progressBar.update(currentLine, {
      action: `Processing batch ${currentBatch}`,
    });

    const vehicleIdArr = batch.map(({ vehicleId }) => vehicleId.toString());
    const componentIdArr = batch.map(({ componentId }) => componentId.toString());

    const partsArr = batch.map(({ parts }) => (parts ? pg.escapeLiteral(parts) : "null")).join(",");
    const laborsArr = batch
      .map(({ labors }) => (labors ? pg.escapeLiteral(labors) : "null"))
      .join(",");

    const sqlStr = `
        UPDATE component
        SET parts = data.parts, labors = data.labors
        FROM (SELECT UNNEST(ARRAY[${vehicleIdArr}]) AS vehicle_id,
                     UNNEST(ARRAY[${componentIdArr}]) AS component_id,
                     UNNEST(ARRAY[${partsArr}]::JSON[]) AS parts,
                     UNNEST(ARRAY[${laborsArr}]::JSON[]) AS labors
        ) AS data
        WHERE component.alldata_vehicle_id = data.vehicle_id AND
              component.alldata_id = data.component_id;
      `;

    try {
      await sql.raw(sqlStr).execute(db);
    } catch (error) {
      fs.writeFileSync("deleteme.sql", sqlStr, { encoding: "utf-8" });
      throw error;
    }

    batch = [];
    currentBatch++;
  };

  for await (const line of lines) {
    if (line.startsWith("vehicleId;")) {
      // Skip the column title line(s).
      currentLine++;
      continue;
    }

    const semiColonReplaced = line.trim().replace(/(?<!(^\d+|^\d+;\d+));(?!\{|$)/g, "-");
    const columns = semiColonReplaced.split(";");

    if (columns.length !== 4) {
      // Write faulty line to an error log file.
      console.error(line.red);
    }

    const [componentId, vehicleId, parts, labors] = columns;

    batch.push({
      vehicleId,
      componentId,
      parts,
      labors,
    });

    if (batch.length >= 10000) {
      await processBatch();
    }

    currentLine++;
  }

  // Process last batch.
  await processBatch();
}

async function loadDatabase() {
  //await loadVehicleData();
  //await loadComponentData();
  await idk();
}

//await resetPostgres();
await loadDatabase();
