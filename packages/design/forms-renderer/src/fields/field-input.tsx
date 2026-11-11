import type { FieldBlock, FieldBlockOf } from '@weldsuite/forms-engine';
import type { FieldViewProps } from '../env';
import { ChoiceField, DropdownField, YesNoField } from './choice-fields';
import { CompositeField } from './composite-fields';
import { DateField } from './date-field';
import { FileUploadField, SignatureField } from './file-fields';
import { MatrixField, RankingField } from './ranking-matrix-fields';
import { NpsField, OpinionScaleField, RatingField } from './scale-fields';
import { NumberField, TextField } from './text-fields';

/** The input of one field, chosen by its type. */
export function FieldInput(props: FieldViewProps<FieldBlock>) {
  const { field } = props;
  switch (field.type) {
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'phone':
    case 'website':
      return <TextField {...(props as FieldViewProps<FieldBlockOf<typeof field.type>>)} />;
    case 'number':
      return <NumberField {...(props as FieldViewProps<FieldBlockOf<'number'>>)} />;
    case 'date':
      return <DateField {...(props as FieldViewProps<FieldBlockOf<'date'>>)} />;
    case 'multiple_choice':
    case 'picture_choice':
      return <ChoiceField {...(props as FieldViewProps<FieldBlockOf<'multiple_choice' | 'picture_choice'>>)} />;
    case 'dropdown':
      return <DropdownField {...(props as FieldViewProps<FieldBlockOf<'dropdown'>>)} />;
    case 'yes_no':
    case 'legal':
      return <YesNoField {...(props as FieldViewProps<FieldBlockOf<'yes_no' | 'legal'>>)} />;
    case 'rating':
      return <RatingField {...(props as FieldViewProps<FieldBlockOf<'rating'>>)} />;
    case 'opinion_scale':
      return <OpinionScaleField {...(props as FieldViewProps<FieldBlockOf<'opinion_scale'>>)} />;
    case 'nps':
      return <NpsField {...(props as FieldViewProps<FieldBlockOf<'nps'>>)} />;
    case 'ranking':
      return <RankingField {...(props as FieldViewProps<FieldBlockOf<'ranking'>>)} />;
    case 'matrix':
      return <MatrixField {...(props as FieldViewProps<FieldBlockOf<'matrix'>>)} />;
    case 'file_upload':
      return <FileUploadField {...(props as FieldViewProps<FieldBlockOf<'file_upload'>>)} />;
    case 'signature':
      return <SignatureField {...(props as FieldViewProps<FieldBlockOf<'signature'>>)} />;
    case 'contact_info':
    case 'address':
      return <CompositeField {...(props as FieldViewProps<FieldBlockOf<'contact_info' | 'address'>>)} />;
  }
}
