const form = document.getElementById("conversion-form");
const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const browseButton = document.getElementById("browse-button");
const removeFileButton = document.getElementById("remove-file");
const outputFormat = document.getElementById("output-format");
const formatHelp = document.getElementById("format-help");
const convertButton = document.getElementById("convert-button");
const buttonText = document.getElementById("button-text");
const notice = document.getElementById("notice");
const filePreview = document.getElementById("file-preview");

const result = document.getElementById("result");
const resultIcon = document.getElementById("result-icon");
const resultTitle = document.getElementById("result-title");
const resultDescription = document.getElementById("result-description");
const progressBar = document.getElementById("progress-bar");
const progressStatus = document.getElementById("progress-status");
const progressPercent = document.getElementById("progress-percent");
const downloadButton = document.getElementById("download-button");
const jobIdText = document.getElementById("job-id");

const MAX_FILE_SIZE = 500 * 1024 * 1024;

const imageFormats = [
  { value: "jpg", label: "JPG" },
  { value: "jpeg", label: "JPEG" },
  { value: "png", label: "PNG" },
  { value: "webp", label: "WebP" }
];

const videoFormats = [
  { value: "mp4", label: "MP4" },
  { value: "webm", label: "WebM" },
  { value: "mp3", label: "MP3" }
];

let selectedFile = null;
let isProcessing = false;

function showNotice(message, type = "info") {
  notice.textContent = message;
  notice.className = `notice ${type}`;
  notice.hidden = false;
}

function hideNotice() {
  notice.textContent = "";
  notice.className = "notice";
  notice.hidden = true;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getFileCategory(file) {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();

  if (
    type.startsWith("image/") ||
    /\.(jpg|jpeg|png|webp|gif|bmp|tif|tiff|avif)$/.test(name)
  ) {
    return "image";
  }

  if (
    type.startsWith("video/") ||
    /\.(mp4|webm|mov|mkv|avi|m4v|mpeg|mpg)$/.test(name)
  ) {
    return "video";
  }

  if (
    type.startsWith("audio/") ||
    /\.(mp3|wav|ogg|m4a|aac|flac)$/.test(name)
  ) {
    return "audio";
  }

  return "unknown";
}

function populateFormats(category) {
  let formats = [];

  if (category === "image") {
    formats = imageFormats;
    formatHelp.textContent = "Formatos de imagem: JPG, JPEG, PNG e WebP.";
  } else if (category === "video") {
    formats = videoFormats;
    formatHelp.textContent = "Formatos de saída: MP4, WebM e MP3.";
  } else if (category === "audio") {
    formats = [{ value: "mp3", label: "MP3" }];
    formatHelp.textContent = "Formato de saída disponível: MP3.";
  } else {
    formatHelp.textContent =
      "Selecione um vídeo, áudio ou imagem em um formato reconhecido.";
  }

  outputFormat.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = formats.length
    ? "Selecione o formato"
    : "Formato não reconhecido";

  outputFormat.appendChild(placeholder);

  formats.forEach(format => {
    const option = document.createElement("option");
    option.value = format.value;
    option.textContent = format.label;
    outputFormat.appendChild(option);
  });

  outputFormat.disabled = formats.length === 0;
}

function resetResult() {
  result.hidden = true;
  downloadButton.hidden = true;
  downloadButton.removeAttribute("href");
  jobIdText.textContent = "";
  progressBar.style.width = "0%";
}

function selectFile(file) {
  if (!file) return;

  if (isProcessing) {
    showNotice("Aguarde a conversão atual terminar.", "info");
    return;
  }

  hideNotice();
  resetResult();

  if (file.size > MAX_FILE_SIZE) {
    selectedFile = null;
    fileInput.value = "";
    filePreview.hidden = true;
    showNotice("O arquivo ultrapassa o limite de 500 MB.", "error");
    return;
  }

  if (file.size === 0) {
    selectedFile = null;
    fileInput.value = "";
    filePreview.hidden = true;
    showNotice("O arquivo está vazio. Selecione outro arquivo.", "error");
    return;
  }

  selectedFile = file;

  document.getElementById("file-name").textContent = file.name;
  document.getElementById("file-size").textContent = formatBytes(file.size);

  const category = getFileCategory(file);
  document.getElementById("file-icon").textContent =
    category === "image" ? "🖼️" :
    category === "video" ? "🎬" :
    category === "audio" ? "🎵" : "📄";

  filePreview.hidden = false;
  populateFormats(category);

  if (category === "unknown") {
    showNotice("Não reconheci o formato deste arquivo.", "error");
  }
}

browseButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    selectFile(fileInput.files[0]);
  }
});

removeFileButton.addEventListener("click", () => {
  if (isProcessing) return;

  selectedFile = null;
  fileInput.value = "";
  filePreview.hidden = true;

  populateFormats("unknown");
  hideNotice();
  resetResult();
});

["dragenter", "dragover"].forEach(eventName => {
  dropzone.addEventListener(eventName, event => {
    event.preventDefault();

    if (!isProcessing) {
      dropzone.classList.add("dragover");
    }
  });
});

["dragleave", "drop"].forEach(eventName => {
  dropzone.addEventListener(eventName, event => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
  });
});

dropzone.addEventListener("drop", event => {
  if (isProcessing) return;

  const file = event.dataTransfer.files[0];

  if (file) {
    selectFile(file);
  }
});

function updateProgress(status) {
  const states = {
    queued: {
      percent: 15,
      label: "Aguardando na fila",
      title: "Arquivo recebido",
      description: "Seu arquivo está aguardando processamento.",
      icon: "◷"
    },
    processing: {
      percent: 65,
      label: "Convertendo arquivo",
      title: "Conversão em andamento",
      description: "O worker está processando seu arquivo.",
      icon: "⟳"
    },
    completed: {
      percent: 100,
      label: "Concluído",
      title: "Conversão concluída!",
      description: "Seu arquivo está pronto para baixar.",
      icon: "✓"
    },
    failed: {
      percent: 100,
      label: "Falha",
      title: "Não foi possível converter",
      description: "O processamento falhou.",
      icon: "!"
    }
  };

  const state = states[status] || states.queued;

  result.hidden = false;
  resultIcon.textContent = state.icon;
  resultTitle.textContent = state.title;
  resultDescription.textContent = state.description;
  progressBar.style.width = `${state.percent}%`;
  progressStatus.textContent = state.label;
  progressPercent.textContent = `${state.percent}%`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function trackJob(id) {
  const maxAttempts = 360;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(2000);

    const response = await fetch(`/jobs/${encodeURIComponent(id)}`);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.mensagem || "Não foi possível consultar o trabalho."
      );
    }

    const job = data.job || data;

    updateProgress(job.status);
    jobIdText.textContent = `Identificador: ${job.id || id}`;

    if (job.status === "completed") {
      downloadButton.href = `/jobs/${encodeURIComponent(id)}/download`;
      downloadButton.hidden = false;
      showNotice("Arquivo convertido com sucesso!", "success");
      return;
    }

    if (job.status === "failed") {
      throw new Error(
        job.error_message ||
        "O worker não conseguiu converter este arquivo."
      );
    }
  }

  throw new Error(
    "A conversão está demorando mais que o esperado. Consulte o status novamente."
  );
}

form.addEventListener("submit", async event => {
  event.preventDefault();

  if (isProcessing) return;

  if (!selectedFile) {
    showNotice("Selecione um arquivo antes de continuar.", "error");
    return;
  }

  const category = getFileCategory(selectedFile);

  const validFormats = category === "image"
    ? imageFormats.map(format => format.value)
    : category === "video"
      ? videoFormats.map(format => format.value)
      : category === "audio"
        ? ["mp3"]
        : [];

  if (!validFormats.includes(outputFormat.value)) {
    showNotice(
      "Selecione um formato de saída válido para o arquivo.",
      "error"
    );
    return;
  }

  if (!form.reportValidity()) return;

  isProcessing = true;
  convertButton.disabled = true;
  browseButton.disabled = true;
  removeFileButton.disabled = true;
  buttonText.textContent = "Enviando arquivo...";

  hideNotice();
  resetResult();

  try {
    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("output_format", outputFormat.value);
    formData.append(
      "email",
      document.getElementById("email").value.trim()
    );

    const response = await fetch("/jobs", {
      method: "POST",
      body: formData
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.mensagem || data.error || "A API recusou o arquivo."
      );
    }

    const job = data.job;

    if (!job || !job.id) {
      throw new Error("A API não retornou o identificador do trabalho.");
    }

    showNotice(
      data.mensagem || "Arquivo enviado para conversão.",
      "success"
    );

    updateProgress(job.status || "queued");
    jobIdText.textContent = `Identificador: ${job.id}`;
    buttonText.textContent = "Acompanhando conversão...";

    await trackJob(job.id);
  } catch (error) {
    showNotice(
      error.message || "Ocorreu um erro inesperado.",
      "error"
    );

    if (!result.hidden) {
      resultTitle.textContent = "Verifique o processamento";
      resultDescription.textContent = error.message;
    }
  } finally {
    isProcessing = false;
    convertButton.disabled = false;
    browseButton.disabled = false;
    removeFileButton.disabled = false;
    buttonText.textContent = "Converter arquivo";
  }
});

populateFormats("unknown");