// Add/edit item form helper (R27a step 2): before submitting, try to download
// the chosen picture in the browser and shrink it, so the Worker doesn't have
// to fetch it. If the store doesn't allow that (CORS), the form is submitted
// unchanged and the Worker downloads the picture instead.
(function () {
  var MAX = 1200;

  function shrink(blob) {
    if (!window.createImageBitmap) return Promise.resolve(blob);
    return createImageBitmap(blob).then(function (bmp) {
      var scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      if (scale === 1 && blob.size < 600 * 1024) return blob;
      var canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      return new Promise(function (resolve) {
        canvas.toBlob(function (out) { resolve(out || blob); }, "image/jpeg", 0.85);
      });
    });
  }

  function setFile(input, blob) {
    if (typeof DataTransfer === "undefined") return false;
    var dt = new DataTransfer();
    dt.items.add(new File([blob], "image.jpg", { type: blob.type || "image/jpeg" }));
    input.files = dt.files;
    return true;
  }

  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form.matches || !form.matches("[data-image-form]") || form.dataset.ready) return;
    var fileInput = form.querySelector('input[name="image_file"]');
    var picked = form.querySelector('input[name="image_url"]:checked') || form.querySelector('input[type="url"][name="image_url"]');
    var uploaded = fileInput && fileInput.files && fileInput.files[0];
    var url = picked && picked.value;
    if (!fileInput || (!uploaded && !url)) return;

    e.preventDefault();
    var button = form.querySelector('button[type="submit"]');
    if (button) { button.disabled = true; button.textContent = "Saving…"; }
    var source = uploaded
      ? Promise.resolve(uploaded)
      : fetch(url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" }).then(function (r) {
          if (!r.ok) throw new Error("download failed");
          return r.blob();
        });
    source
      .then(shrink)
      .then(function (blob) { setFile(fileInput, blob); })
      .catch(function () { /* leave it to the server */ })
      .then(function () {
        form.dataset.ready = "1";
        form.submit();
      });
  });
})();
