import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { View } from 'react-native';

import { FEATURES } from '@/features/legal/constants';
import { ConsentCheckbox } from '@/features/legal/components/ConsentCheckbox';
import type { AboutYou } from '@/lib/database.types';
import { Banner, Button, Card, Text, TextField, useTheme } from '@/ui';

import {
  CONTACT_NAME_MAX,
  CONTACT_PHONE_MAX,
  CONTACT_RELATIONSHIP_MAX,
  GENDER_OPTIONS,
  TSHIRT_SIZES,
  aboutYouErrorMessage,
  aboutYouSignature,
  buildSaveRequest,
  createAboutYouSchema,
  formFieldFor,
  formValuesFrom,
  isEmptyRequest,
  rulesFrom,
  type AboutYouFormValues,
} from '../domain/aboutYou';
import { useSaveAboutYou } from '../hooks/useAboutYou';
import { ChoiceChips } from './ChoiceChips';

/** Plain-language text of the two agreements. Kept here, next to the boxes it explains. */
const DEMOGRAPHICS_TEXT =
  'Organizers never see your birth year or gender next to your name. They only see grouped totals for the whole community (for example how many members are in an age band), and only for groups of 5 or more people: smaller groups are hidden. You can clear these details at any time, and turning off this agreement in Profile, then Privacy, deletes them.';
const EMERGENCY_TEXT =
  'The organizers of your communities can see your emergency contact and T-shirt size, so they can reach someone if something happens at an event and can order race kits. Other members cannot see them. Please tell your contact that you gave their details. You can clear these details at any time, and turning off this agreement in Profile, then Privacy, deletes them.';

function AgreementBlock({
  agreed,
  error,
  checkbox,
  testID,
}: {
  agreed: boolean;
  error: string | undefined;
  checkbox: { label: string; checked: boolean; onChange: (checked: boolean) => void };
  testID: string;
}) {
  const { spacing } = useTheme();
  if (agreed) {
    return (
      <Text variant="caption" color="success">
        You agreed to this. You can turn it off in Profile, then Privacy.
      </Text>
    );
  }
  return (
    <View style={{ gap: spacing.xs }}>
      <ConsentCheckbox testID={testID} label={checkbox.label} checked={checkbox.checked} onChange={checkbox.onChange} />
      {error ? (
        <Text variant="caption" color="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The About-you form: two separate blocks, each with its own agreement. Saving
 * records the agreement a block needs (only when it is not on record yet),
 * then stores the changed fields. Either block may stay empty.
 */
export function AboutYouForm({
  data,
  welcome,
  onSaved,
  onNothingToSave,
  onSkip,
}: {
  data: AboutYou;
  /** First-time layout: a "Skip for now" button next to Save. */
  welcome: boolean;
  onSaved: () => void;
  onNothingToSave: () => void;
  onSkip: () => void;
}) {
  const { spacing } = useTheme();
  const save = useSaveAboutYou();
  const signature = aboutYouSignature(data);
  const rules = useMemo(() => rulesFrom(data), [data]);
  const schema = useMemo(() => createAboutYouSchema(rules), [rules]);
  const { control, handleSubmit, reset, setError } = useForm<AboutYouFormValues>({
    resolver: zodResolver(schema) as Resolver<AboutYouFormValues>,
    defaultValues: formValuesFrom(data),
  });
  const [problem, setProblem] = useState<string | null>(null);

  // Start again from the server's copy when it changes (after a save or a clear).
  useEffect(() => {
    reset(formValuesFrom(data));
    // `data` is covered by its signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, reset]);

  const submit = handleSubmit((values) => {
    if (save.isPending) return;
    setProblem(null);
    const request = buildSaveRequest(values, data);
    if (isEmptyRequest(request)) {
      onNothingToSave();
      return;
    }
    save.mutate(request, {
      onSuccess: onSaved,
      onError: (error) => {
        const field = error.code === 'validation_failed' ? formFieldFor(error.field) : null;
        if (field !== null) setError(field, { message: aboutYouErrorMessage(error) });
        else setProblem(aboutYouErrorMessage(error));
      },
    });
  });

  const busy = save.isPending;
  const showDemographics = FEATURES.demographics;
  const showEmergency = FEATURES.emergencyContact;

  return (
    <View style={{ gap: spacing.xl }}>
      {problem ? <Banner tone="error" message={problem} /> : null}

      {showDemographics ? (
        <Card style={{ gap: spacing.md }}>
          <View style={{ gap: spacing.xs }}>
            <Text variant="heading">For community statistics</Text>
            <Text color="textMuted">{DEMOGRAPHICS_TEXT}</Text>
          </View>
          <Controller
            control={control}
            name="birthYear"
            render={({ field, fieldState }) => (
              <TextField
                ref={field.ref}
                label="Birth year"
                helper={`Optional. A year between ${data.birth_year_min} and ${data.birth_year_max}.`}
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
                editable={!busy}
                keyboardType="number-pad"
                maxLength={4}
                autoComplete="off"
                testID="about-you-birth-year"
              />
            )}
          />
          <Controller
            control={control}
            name="gender"
            render={({ field }) => (
              <ChoiceChips
                label="Gender (optional)"
                options={GENDER_OPTIONS}
                value={field.value}
                onChange={field.onChange}
                disabled={busy}
                testID="about-you-gender"
              />
            )}
          />
          <Controller
            control={control}
            name="agreeDemographics"
            render={({ field, fieldState }) => (
              <AgreementBlock
                agreed={data.consents.profile_demographics}
                error={fieldState.error?.message}
                testID="about-you-agree-demographics"
                checkbox={{
                  label: 'I agree that TrainHive stores my birth year and gender for these grouped statistics',
                  checked: field.value,
                  onChange: field.onChange,
                }}
              />
            )}
          />
        </Card>
      ) : null}

      {showEmergency ? (
        <Card style={{ gap: spacing.md }}>
          <View style={{ gap: spacing.xs }}>
            <Text variant="heading">For safety and race kits</Text>
            <Text color="textMuted">{EMERGENCY_TEXT}</Text>
          </View>
          <Controller
            control={control}
            name="contactName"
            render={({ field, fieldState }) => (
              <TextField
                ref={field.ref}
                label="Emergency contact name"
                helper="Optional. The person to call if something happens."
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
                editable={!busy}
                autoCapitalize="words"
                autoCorrect={false}
                autoComplete="off"
                maxLength={CONTACT_NAME_MAX * 2}
                testID="about-you-contact-name"
              />
            )}
          />
          <Controller
            control={control}
            name="contactPhone"
            render={({ field, fieldState }) => (
              <TextField
                ref={field.ref}
                label="Emergency contact phone number"
                helper="Digits, spaces and + ( ) . / -"
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
                editable={!busy}
                keyboardType="phone-pad"
                autoComplete="off"
                maxLength={CONTACT_PHONE_MAX * 2}
                testID="about-you-contact-phone"
              />
            )}
          />
          <Controller
            control={control}
            name="contactRelationship"
            render={({ field, fieldState }) => (
              <TextField
                ref={field.ref}
                label="Relationship (optional)"
                helper="For example partner, parent or friend."
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                error={fieldState.error?.message}
                editable={!busy}
                autoCapitalize="sentences"
                autoComplete="off"
                maxLength={CONTACT_RELATIONSHIP_MAX * 2}
                testID="about-you-contact-relationship"
              />
            )}
          />
          <Controller
            control={control}
            name="tshirtSize"
            render={({ field }) => (
              <ChoiceChips
                label="T-shirt size (optional)"
                options={TSHIRT_SIZES.map((size) => ({ value: size, label: size }))}
                value={field.value}
                onChange={field.onChange}
                disabled={busy}
                testID="about-you-tshirt"
              />
            )}
          />
          <Controller
            control={control}
            name="agreeEmergency"
            render={({ field, fieldState }) => (
              <AgreementBlock
                agreed={data.consents.emergency_contact}
                error={fieldState.error?.message}
                testID="about-you-agree-emergency"
                checkbox={{
                  label: 'I agree that organizers of my communities may see my emergency contact and T-shirt size',
                  checked: field.value,
                  onChange: field.onChange,
                }}
              />
            )}
          />
        </Card>
      ) : null}

      <View style={{ gap: spacing.sm }}>
        <Button
          label="Save"
          size="lg"
          fullWidth
          loading={busy}
          onPress={() => void submit()}
          testID="about-you-save"
        />
        {welcome ? (
          <Button
            label="Skip for now"
            variant="ghost"
            size="lg"
            fullWidth
            disabled={busy}
            onPress={onSkip}
            accessibilityHint="Nothing is saved. You can add details later in Profile, then About you."
            testID="about-you-skip"
          />
        ) : null}
      </View>
    </View>
  );
}
