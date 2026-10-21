// Deliberate type error to prove post-merge self-healing (issue #8, Phase D).
export const brokenValue: number = "this is a string, not a number";
