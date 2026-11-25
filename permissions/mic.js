const btnRequest = document.getElementById("btn-request-mic");
const statusEl = document.getElementById("mic-status");

async function requestMic() {
  btnRequest.disabled = true;
  statusEl.className = "status";
  statusEl.textContent = "Esperando tu confirmación en el aviso de Chrome...";

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }

    statusEl.className = "status ok";
    statusEl.textContent =
      "¡Micrófono autorizado! Cerrando esta pestaña para volver al panel...";

    await chrome.runtime
      .sendMessage({ type: "MIC_PERMISSION_GRANTED" })
      .catch(() => {});

    setTimeout(() => {
      window.close();
    }, 1200);
  } catch (err) {
    btnRequest.disabled = false;
    statusEl.className = "status err";
    statusEl.textContent = `No se concedió el permiso: ${
      err instanceof Error ? err.message : String(err)
    }. Haz clic en el ícono del candado/ajustes en la barra de dirección para habilitar el micrófono.`;
  }
}

btnRequest.addEventListener("click", requestMic);
requestMic();
