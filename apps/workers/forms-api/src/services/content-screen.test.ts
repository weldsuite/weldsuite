import { describe, expect, it } from 'vitest';
import { formDefinitionSchema } from '@weldsuite/forms-engine/definition';
import { screenForm } from './content-screen';

const form = (...titles: string[]) =>
  formDefinitionSchema.parse({
    blocks: titles.map((title, i) => ({ id: `b_${i}`, ref: `q_${i}`, type: 'short_text', title, properties: {} })),
    endings: [{ id: 'e_1', ref: 'done', title: 'Thanks' }],
  });

describe('screenForm', () => {
  it('lets ordinary forms through', () => {
    expect(screenForm('Customer feedback', form('How was your visit?', 'Which Google product do you use?', 'Your email'))).toBeNull();
    expect(screenForm('Event registration', form('Dietary needs', 'Which session do you pick?'))).toBeNull();
  });

  it('holds a question that asks for a credential', () => {
    expect(screenForm('Survey', form('Enter your password'))).toContain('credential');
    expect(screenForm('Survey', form('Card number', 'Wachtwoord'))).toContain('credential');
    expect(screenForm('Survey', form('Your PIN'))).toContain('credential');
    expect(screenForm('Survey', form('Security code on the back'))).toContain('credential');
  });

  it('holds a brand next to an account-takeover word, in the title or a question', () => {
    expect(screenForm('Microsoft: verify your account', form('Name'))).toContain('imitates');
    expect(screenForm('Survey', form('Sign in with your PayPal account'))).toContain('imitates');
    expect(screenForm('Update your DigiD', form('Name'))).toContain('imitates');
  });
});
