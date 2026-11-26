import { Hono } from "hono";
import type { AppEnv } from "../env";
import { optionalViewer } from "../lib/auth";
import { Layout } from "../views/layout";
import { mainUrl } from "./util";

export const installRoutes = new Hono<AppEnv>();

/**
 * The bookmarklet is a tiny loader (R22): it pulls the current capture.js from
 * this site, so fixes reach everyone without reinstalling. If the store's
 * security policy blocks the script, it falls back to sending just the page
 * address and title.
 */
export function bookmarklet(origin: string): string {
  const o = JSON.stringify(origin);
  return (
    "javascript:(function(){var o=" +
    o +
    ",s=document.createElement('script');s.src=o+'/capture.js?t='+Date.now();" +
    "s.onerror=function(){var u=o+'/add?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title);" +
    "if(!window.open(u,'_blank'))location.href=u};document.body.appendChild(s)})();"
  );
}

installRoutes.get("/install", async (c) => {
  if (c.get("site").kind !== "main") return c.redirect(`${mainUrl(c)}/install`);
  const origin = mainUrl(c);
  const code = bookmarklet(origin);
  return c.html(
    <Layout title="Install the Add to Wishlist button" viewer={await optionalViewer(c)}>
      <h1>Add things from any store</h1>
      <p>
        Open a product page, tap <strong>Add to Wishlist</strong>, and the price, picture and options you picked are
        filled in for you. You check them, choose a list, and save.
      </p>

      <section class="card">
        <h2 style="margin-top:0">On a computer</h2>
        <p>Show your bookmarks bar, then drag this button onto it:</p>
        <p>
          <a class="btn primary" href={code} onclick="return false;" title="Drag me to your bookmarks bar">
            Add to Wishlist
          </a>
        </p>
        <p class="muted">
          On a Mac, Safari bookmarks sync to your iPhone and iPad through iCloud, so this also installs it there.
        </p>
      </section>

      <section class="card">
        <h2 style="margin-top:0">On iPhone or iPad: Share sheet shortcut</h2>
        <p>This puts “Add to Wishlist” in Safari's Share menu.</p>
        <ol class="steps">
          <li>
            Open the <strong>Shortcuts</strong> app, tap <strong>+</strong>, and name the shortcut “Add to Wishlist”.
          </li>
          <li>
            Tap the <strong>ⓘ</strong> button, turn on <strong>Show in Share Sheet</strong>, and set it to receive{" "}
            <strong>Safari web pages</strong>.
          </li>
          <li>
            Add the action <strong>Get Contents of URL</strong> with this address:
            <pre class="code">{`${origin}/capture.js`}</pre>
          </li>
          <li>
            Add the action <strong>Run JavaScript on Web Page</strong>. Delete the sample script and insert the{" "}
            <strong>Contents of URL</strong> variable as the whole script.
          </li>
          <li>
            Add the action <strong>Open URLs</strong> with this address followed by the <strong>JavaScript Result</strong>{" "}
            variable:
            <pre class="code">{`${origin}/add?d=`}</pre>
          </li>
        </ol>
        <p class="muted">These steps haven't been tested on a real iPhone yet.</p>
      </section>

      <section class="card">
        <h2 style="margin-top:0">On iPhone or iPad: bookmark</h2>
        <ol class="steps">
          <li>Bookmark any page in Safari.</li>
          <li>
            Open your bookmarks, tap <strong>Edit</strong>, then the new bookmark. Rename it “Add to Wishlist”.
          </li>
          <li>Replace its address with this text:</li>
        </ol>
        <pre class="code" id="bm">{code}</pre>
        <p>
          <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('bm').textContent).then(function(){this.textContent='Copied'}.bind(this))">
            Copy
          </button>
        </p>
        <p class="muted">To use it, open a product page, tap the address bar, and choose the bookmark.</p>
      </section>

      <section class="card">
        <h2 style="margin-top:0">Shopping in the Amazon app?</h2>
        <p>
          Tap Share, copy the link, and paste it into the <a href={`${origin}/add`}>Add an item</a> page. You'll need to
          type the price yourself.
        </p>
      </section>
    </Layout>,
  );
});
