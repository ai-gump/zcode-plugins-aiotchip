import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(resolve(root, "dist"), { recursive: true });
await cp(resolve(root, "src/templates"), resolve(root, "dist/templates"), { recursive: true });
await cp(resolve(root, "src/serial-helper.py"), resolve(root, "dist/serial-helper.py"));

async function inlineClient(htmlFile, clientFile, stylePlaceholder, styleFile, clientPlaceholder) {
  const client = await build({
    entryPoints: [resolve(root, "ui", clientFile)],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    write: false,
    legalComments: "inline",
  });
  let page = await readFile(resolve(root, "ui", htmlFile), "utf8");
  if (stylePlaceholder) {
    page = page.replace(stylePlaceholder, await readFile(resolve(root, "ui", styleFile), "utf8"));
  }
  page = page.replace(
    clientPlaceholder,
    () => client.outputFiles[0].text.replaceAll("</script", "<\\/script"),
  );
  await writeFile(resolve(root, "dist", "ui", htmlFile), page);
}

await mkdir(resolve(root, "dist/ui"), { recursive: true });
await inlineClient("panel.html", "panel-client.mjs", "/*__PANEL_STYLES__*/", "style.css", "/*__PANEL_CLIENT__*/");
await inlineClient("card.html", "card-client.mjs", null, null, "/*__CARD_CLIENT__*/");

await build({
  entryPoints: [resolve(root, "src/server.ts")],
  outfile: resolve(root, "dist/server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  legalComments: "inline",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require=__createRequire(import.meta.url);',
  },
});
