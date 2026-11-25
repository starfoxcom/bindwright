// Every git this test process starts, the engines' own included, runs with this
// computer's hooks folder turned off: a hooks folder set for every repo would
// otherwise run on each test repo's init and commit, and some cost 90 ms a call.
const index = Number(process.env.GIT_CONFIG_COUNT || 0);
process.env.GIT_CONFIG_COUNT = String(index + 1);
process.env[`GIT_CONFIG_KEY_${index}`] = "core.hooksPath";
process.env[`GIT_CONFIG_VALUE_${index}`] = "";
