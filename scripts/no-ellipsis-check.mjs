import { promises as fs } from "node:fs";
import globby from "globby";

const files = await globby([
  "**/*.{ts,tsx,js,jsx}",
  "!node_modules/**",
  "!dist/**",
  "!build/**",
  "!.next/**",
  "!coverage/**"
]);

const offenders = [];
for (const f of files) {
  const text = await fs.readFile(f, "utf8");
  if (/\.\.\.(?![a-zA-Z])/m.test(text)) offenders.push(f);
}

if (offenders.length) {
  console.error("Ellipsis found in:", offenders.join(", "));
  process.exit(1);
}
console.log("No disallowed ellipses.");
