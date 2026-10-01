const dialog = document.querySelector('#lead-dialog');
const serviceField = document.querySelector('#service-field');
const form = document.querySelector('#lead-form');
const formNote = document.querySelector('#form-note');
const resumeDialog = document.querySelector('#resume-dialog');
const resumeForm = document.querySelector('#resume-form');
const resumeNote = document.querySelector('#resume-note');

document.querySelectorAll('.js-open-form').forEach((button) => {
  button.addEventListener('click', () => {
    serviceField.value = button.dataset.service || 'Консультация';
    dialog.showModal();
  });
});

document.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

document.querySelectorAll('.js-open-resume').forEach((button) => {
  button.addEventListener('click', () => resumeDialog.showModal());
});

document.querySelector('.resume-close').addEventListener('click', () => resumeDialog.close());
resumeDialog.addEventListener('click', (event) => {
  if (event.target === resumeDialog) resumeDialog.close();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  formNote.textContent = 'Подключаем передачу заявок в Bitrix24. Форма станет активной перед публикацией.';
  formNote.style.color = '#d8ff00';
});

resumeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  resumeNote.textContent = 'Подключаем передачу резюме в Bitrix24. Форма станет активной перед публичным запуском.';
  resumeNote.style.color = '#d8ff00';
});
