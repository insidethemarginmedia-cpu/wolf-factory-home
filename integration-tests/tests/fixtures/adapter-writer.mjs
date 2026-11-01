// Child-process writer used by the multi-process concurrency test.
import { WolfMissionStore } from '../../adapter/wolf-adapter.mjs';
const [path, prefix, countStr] = process.argv.slice(2);
const store = new WolfMissionStore(path);
for (let i = 0; i < Number(countStr); i++) {
  await store.transact((doc) => { doc.idempotent[`${prefix}:${i}`] = { result: i }; });
}
