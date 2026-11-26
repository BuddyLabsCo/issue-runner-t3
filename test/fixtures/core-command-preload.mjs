import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// Core uses shell-free execFile; run the same GitHub substitute on both platforms.
childProcess.execFile = new Proxy(childProcess.execFile, {
  apply(target, thisArg, [file, args, ...rest]) {
    return Reflect.apply(
      target,
      thisArg,
      file === "gh"
        ? [process.execPath, [process.env.FIXTURE_GH_ENTRY, ...args], ...rest]
        : [file, args, ...rest],
    );
  },
});
syncBuiltinESMExports();
