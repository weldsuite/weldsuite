import { accounting } from './accounting';
import { navigation } from './navigation';
import { sweep } from './sweep';
import { weldbooksBr } from './weldbooks-br';

/**
 * Português do Brasil (pt-BR). Parcial: começa pelo WeldBooks Brasil e cai no
 * inglês para o resto (`withEnglishFallback` no carregador de idiomas).
 */
export const pt = {
  accounting,
  navigation,
  sweep,
  weldbooksBr,
};
