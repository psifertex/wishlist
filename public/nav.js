// Person-hostname pages can't see the main site's login cookie, so they ask
// the main site who's logged in and update the header and "Log in" buttons.
(function () {
  var script = document.currentScript;
  var main = script && script.getAttribute("data-main");
  if (!main) return;

  function link(href, text) {
    var a = document.createElement("a");
    a.href = main + href;
    a.textContent = text;
    return a;
  }

  fetch(main + "/api/whoami", { credentials: "include" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (who) {
      if (!who || !who.loggedIn) return;
      var nav = document.getElementById("site-nav");
      if (nav) {
        nav.textContent = "";
        nav.appendChild(link("/app", "My lists"));
        nav.appendChild(link("/install", "Get the button"));
        if (who.isAdmin) nav.appendChild(link("/app/admin", "Admin"));
        nav.appendChild(link("/logout", "Log out"));
      }
      document.querySelectorAll("main [data-login-link]").forEach(function (a) {
        a.textContent = "My lists";
      });
      // The owner of this list: don't offer the buying view (which would show
      // what's been bought for them). The main site enforces this too.
      var banner = document.querySelector("[data-buy-banner]");
      if (banner && who.slug && banner.getAttribute("data-owner-slug") === who.slug) {
        banner.textContent = "This is your list. Things people buy for you stay hidden until it's time. ";
        var edit = document.createElement("a");
        edit.href = banner.getAttribute("data-edit-url");
        edit.textContent = "Edit this list";
        banner.appendChild(edit);
      }
    })
    .catch(function () { /* stay as-is */ });
})();
