import { layOutGraph } from "./dist/console-data.js";
const e = (s, p) => ({ sha: s, shortSha: s, message: s, author: "a", parents: p });
console.log("A:", layOutGraph([e("m",["b","s"]),e("s",["r"]),e("b",["r"]),e("r",[])]).map(c=>`${c.shortSha}:${c.lane}`).join(" "));
console.log("B:", layOutGraph([e("m2",["m1","s2"]),e("s2",["b1"]),e("m1",["b0","s1"]),e("s1",["b0"]),e("b1",["b0"]),e("b0",[])]).map(c=>`${c.shortSha}:${c.lane}`).join(" "));
console.log("C:", layOutGraph([e("z",["r"]),e("m",["b","z"]),e("b",["r"]),e("r",[])]).map(c=>`${c.shortSha}:${c.lane}`).join(" "));
