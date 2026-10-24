// Run learned.onnx in onnxruntime-web (wasm backend, as in the viewer) and compare with the torch outputs saved by train.py.
// usage (from a dir with onnxruntime-web installed): node <repo>/worldmodel/check_onnx_web.mjs learned.onnx onnx_check.json
import { createRequire } from "module";
import { readFileSync } from "fs";
const ort = createRequire(process.cwd() + "/")("onnxruntime-web");
const [model, check] = process.argv.slice(2);
const { x, outputs } = JSON.parse(readFileSync(check, "utf8"));
ort.env.wasm.numThreads = 1;
const s = await ort.InferenceSession.create(readFileSync(model), { executionProviders: ["wasm"] });
const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", Float32Array.from(x.flat()), [x.length, x[0].length]) });
let worst = 0;
for (const [i, k] of s.outputNames.entries()) {
  const ref = outputs[i];          // train.py saves the torch outputs as a list in output order
  const got = out[k].data, want = ref.flat(Infinity);
  if (got.length !== want.length) throw new Error(`${k}: ${got.length} values, expected ${want.length}`);
  const d = Math.max(...want.map((v, i) => Math.abs(v - got[i])));
  console.log(`${k} dims=${out[k].dims} max|web - torch|=${d.toExponential(2)}`);
  worst = Math.max(worst, d);
}
console.log(JSON.stringify({ backend: "wasm", ort_web: ort.env.versions?.web, inputs: x.length, max_abs_diff: worst, pass: worst < 1e-4 }));
process.exit(worst < 1e-4 ? 0 : 1);
