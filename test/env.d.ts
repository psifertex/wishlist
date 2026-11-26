type WishlistBindings = import("../src/env").Env;

declare namespace Cloudflare {
  interface Env extends WishlistBindings {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
