import type { Child, FC } from "hono/jsx";
import type { Viewer } from "../env";

export const Layout: FC<{
  title: string;
  viewer?: Viewer | null;
  /** Absolute URL of the main site, for links from person hostnames. */
  mainUrl?: string;
  head?: Child;
  /**
   * Set on person-hostname pages, which can't see the main site's login
   * cookie: public/nav.js asks the main site who's logged in and updates the
   * header and "Log in" buttons.
   */
  checkLogin?: boolean;
  children?: Child;
}> = ({ title, viewer, mainUrl = "", head, checkLogin, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{title}</title>
      <link rel="stylesheet" href="/styles.css" />
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      {head}
      {checkLogin && !viewer && <script src="/nav.js" data-main={mainUrl} defer></script>}
    </head>
    <body>
      <header class="top">
        <a class="brand" href={`${mainUrl}/`}>
          <img src="/logo.svg" alt="" />
          Wishlist
        </a>
        <nav id="site-nav">
          {viewer ? (
            <>
              <a href={`${mainUrl}/app`}>My lists</a>
              <a href={`${mainUrl}/install`}>Get the button</a>
              {viewer.isAdmin && <a href={`${mainUrl}/app/admin`}>Admin</a>}
              <a href={`${mainUrl}/logout`}>Log out</a>
            </>
          ) : (
            <a href={`${mainUrl}/app`} data-login-link>
              Log in
            </a>
          )}
        </nav>
      </header>
      <main>{children}</main>
    </body>
  </html>
);

export const Flash: FC<{ msg?: string | null; kind?: "ok" | "error" }> = ({ msg, kind = "ok" }) =>
  msg ? <p class={`flash ${kind}`}>{msg}</p> : null;

export const Message: FC<{ title: string; children?: Child; mainUrl?: string }> = ({ title, children, mainUrl }) => (
  <Layout title={title} mainUrl={mainUrl}>
    <section class="card narrow">
      <h1>{title}</h1>
      {children}
    </section>
  </Layout>
);
