import {getRequestConfig} from 'next-intl/server';

export default getRequestConfig(async () => {
  return {
    locale: 'pt-BR',
    messages: (await import('./messages/pt-BR.json')).default
  };
});