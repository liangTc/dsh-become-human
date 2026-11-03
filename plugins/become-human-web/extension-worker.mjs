import {pathToFileURL} from 'node:url';
const [entry,home,profile,...args]=process.argv.slice(2);
process.env.DSH_HOME=home;process.env.DSH_TELEMETRY_ENABLED='false';
process.argv=[process.execPath,'dsh','plugin','--profile',profile,...args];
const {runCli}=await import(pathToFileURL(entry).href);
await runCli();
