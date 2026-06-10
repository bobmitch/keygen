/** Wire up drag/drop + file picker on the dropzone. Calls `onFile` with the chosen file. */
export function setupDropzone(
  dropzone: HTMLElement,
  chooseBtn: HTMLButtonElement,
  fileInput: HTMLInputElement,
  onFile: (file: File) => void,
) {
  chooseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) onFile(file);
    fileInput.value = '';
  });

  const prevent = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };

  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      prevent(e);
      dropzone.classList.add('dragover');
    }),
  );
  ['dragleave', 'dragend'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      prevent(e);
      dropzone.classList.remove('dragover');
    }),
  );
  dropzone.addEventListener('drop', (e) => {
    prevent(e);
    dropzone.classList.remove('dragover');
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) onFile(file);
  });

  // Allow dropping anywhere on the window without the browser navigating away.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}
