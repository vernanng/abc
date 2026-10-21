import { layOutGraph } from './dist/console-data.js';
const commits = [
  { sha:"m", shortSha:"m", message:"merge", author:"a", parents:["b","s"] },
  { sha:"s2", shortSha:"s2", message:"side2", author:"a", parents:["s"] },
  { sha:"b", shortSha:"b", message:"trunk", author:"a", parents:["r"] },
  { sha:"s", shortSha:"s", message:"side", author:"a", parents:["r"] },
  { sha:"r", shortSha:"r", message:"root", author:"a", parents:[] },
];
console.log(JSON.stringify(layOutGraph(commits).map(c=>({sha:c.sha,lane:c.lane}))));