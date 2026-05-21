import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveSnapshot } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.join(
	__dirname,
	"..",
	"data",
	"server",
	"knicks_dynasty_import.json",
);

console.log("Reading Knicks Dynasty JSON...");
const data = readFileSync(filePath, "utf8");
console.log(`File size: ${(data.length / 1024 / 1024).toFixed(1)} MB`);

const savedAt = saveSnapshot(1, data, "Knicks Dynasty");
console.log(`Saved snapshot for lid=1 at ${savedAt}`);
