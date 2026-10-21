import { layOutGraph } from "./dist/console-data.js";
const cs = [
  { sha: "M",  shortSha: "M",  message: "merge", author: "a", parents: ["A", "B2"] },
  { sha: "B2", shortSha: "B2", message: "side2", author: "a", parents: ["B1"] },
  { sha: "B1", shortSha: "B1", message: "side1", author: "a", parents: ["C"] },
  { sha: "A",  shortSha: "A",  message: "trunk", author: "a", parents: ["C"] },
  { sha: "C",  shortSha: "C",  message: "root",  author: "a", parents: [] },
];
console.log(layOutGraph(cs).map((c) => c.sha + ":lane" + c.lane).join(" "));
