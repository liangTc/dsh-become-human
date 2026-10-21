import {workerData,parentPort} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(workerData.file);
try{db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=250;PRAGMA secure_delete=ON');const result=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();if(result.busy)throw new Error('Active reader');db.exec('VACUUM');const after=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();if(after.busy)throw new Error('Active reader');parentPort.postMessage({ok:true});}catch{parentPort.postMessage({ok:false});}finally{db.close();}
