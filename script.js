const dialog = document.querySelector('#lead-dialog');
const serviceField = document.querySelector('#service-field');
const form = document.querySelector('#lead-form');
const formNote = document.querySelector('#form-note');

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


form.addEventListener('submit', (event) => {
  event.preventDefault();
  formNote.textContent = 'Подключаем передачу заявок в Bitrix24. Форма станет активной перед публикацией.';
  formNote.style.color = '#d8ff00';
});

