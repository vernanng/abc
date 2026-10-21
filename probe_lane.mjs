import { layOutGraph } from './dist/console-data.js';
const g = layOutGraph([
  { sha: "m2", shortSha: "m2", message: "merge2", author: "a", parents: ["t2", "s2"] },
  { sha: "t2", shortSha: "t2", message: "trunk2", author: "a", parents: ["m1"] },
  { sha: "s2", shortSha: "s2", message: "side2", author: "a", parents: ["t1"] },
  { sha: "m1", shortSha: "m1", message: "merge1", author: "a", parents: ["t1", "s1"] },
  { sha: "t1", shortSha: "t1", message: "trunk1", author: "a", parents: ["r"] },
  { sha: "s1", shortSha: "s1", message: "side1", author: "a", parents: ["r"] },
  { sha: "r", shortSha: "r", message: "root", author: "a", parents: [] },
]);
console.log(g.map(c => `${c.shortSha} lane=${c.lane}`).join('\n'));
