'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useLocale, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import {
  contactSchema,
  type ContactFormInput,
  type ContactInput,
} from '@/lib/validation/contact-schema'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type SubmitState = 'idle' | 'submitting' | 'success' | 'error_not_configured' | 'error_default'

const defaultValues: ContactFormInput = {
  name: '',
  company: '',
  country: '',
  whatsapp: '',
  email: '',
  propertiesCount: '',
  message: '',
  acceptsPrivacy: false,
  company_website: '',
}

function fieldClasses(hasError: boolean) {
  return cn(
    'w-full rounded-lg border bg-white px-3.5 py-2.5 text-sm text-brand-deep placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-offset-0',
    hasError
      ? 'border-red-300 focus:ring-red-200'
      : 'border-slate-200 focus:border-brand-green focus:ring-brand-green/20',
  )
}

export function ContactForm() {
  const t = useTranslations('contact.form')
  const locale = useLocale()
  const [status, setStatus] = useState<SubmitState>('idle')

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ContactFormInput>({
    resolver: zodResolver(contactSchema),
    defaultValues,
  })

  const messageValue = watch('message')

  async function onSubmit(rawValues: ContactFormInput) {
    setStatus('submitting')

    // rawValues already passed schema validation (that's what the resolver
    // just did); re-parsing gives us the *transformed* ContactInput shape
    // (propertiesCount as number, etc.) with correct types, without fighting
    // this resolver version's generics over the input/output split.
    const values: ContactInput = contactSchema.parse({
      ...rawValues,
      locale,
      pageUrl: typeof window !== 'undefined' ? window.location.href : undefined,
    })

    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      const data = (await response.json().catch(() => null)) as { ok: boolean; reason?: string } | null

      if (response.ok && data?.ok) {
        setStatus('success')
        reset(defaultValues)
        return
      }

      if (data?.reason === 'not_configured') {
        setStatus('error_not_configured')
      } else {
        setStatus('error_default')
      }
    } catch {
      setStatus('error_default')
    }
  }

  if (status === 'success') {
    return (
      <div role="status" className="rounded-2xl border border-brand-green/30 bg-brand-green/5 p-6 text-center">
        <p className="text-lg font-semibold text-brand-deep">{t('successTitle')}</p>
        <p className="mt-2 text-sm text-slate-600">{t('successMessage')}</p>
      </div>
    )
  }

  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Honeypot: hidden from real users, real bots often fill every input they find. */}
      <div className="hidden" aria-hidden="true">
        <label htmlFor="company_website">Company website</label>
        <input
          id="company_website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          {...register('company_website')}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="name" className="text-sm font-medium text-brand-deep">
            {t('name')}
          </label>
          <input
            id="name"
            type="text"
            placeholder={t('namePlaceholder')}
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? 'name-error' : undefined}
            className={cn('mt-1.5', fieldClasses(Boolean(errors.name)))}
            {...register('name')}
          />
          {errors.name ? (
            <p id="name-error" className="mt-1 text-xs text-red-600">
              {t('errors.nameRequired')}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="company" className="text-sm font-medium text-brand-deep">
            {t('company')}
          </label>
          <input
            id="company"
            type="text"
            placeholder={t('companyPlaceholder')}
            aria-invalid={Boolean(errors.company)}
            aria-describedby={errors.company ? 'company-error' : undefined}
            className={cn('mt-1.5', fieldClasses(Boolean(errors.company)))}
            {...register('company')}
          />
          {errors.company ? (
            <p id="company-error" className="mt-1 text-xs text-red-600">
              {t('errors.companyRequired')}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="country" className="text-sm font-medium text-brand-deep">
            {t('country')}
          </label>
          <input
            id="country"
            type="text"
            placeholder={t('countryPlaceholder')}
            aria-invalid={Boolean(errors.country)}
            aria-describedby={errors.country ? 'country-error' : undefined}
            className={cn('mt-1.5', fieldClasses(Boolean(errors.country)))}
            {...register('country')}
          />
          {errors.country ? (
            <p id="country-error" className="mt-1 text-xs text-red-600">
              {t('errors.countryRequired')}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="whatsapp" className="text-sm font-medium text-brand-deep">
            {t('whatsapp')}
          </label>
          <input
            id="whatsapp"
            type="tel"
            placeholder={t('whatsappPlaceholder')}
            aria-invalid={Boolean(errors.whatsapp)}
            aria-describedby={errors.whatsapp ? 'whatsapp-error' : undefined}
            className={cn('mt-1.5', fieldClasses(Boolean(errors.whatsapp)))}
            {...register('whatsapp')}
          />
          {errors.whatsapp ? (
            <p id="whatsapp-error" className="mt-1 text-xs text-red-600">
              {t('errors.whatsappRequired')}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="email" className="text-sm font-medium text-brand-deep">
            {t('email')}
          </label>
          <input
            id="email"
            type="email"
            placeholder={t('emailPlaceholder')}
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? 'email-error' : undefined}
            className={cn('mt-1.5', fieldClasses(Boolean(errors.email)))}
            {...register('email')}
          />
          {errors.email ? (
            <p id="email-error" className="mt-1 text-xs text-red-600">
              {t('errors.emailInvalid')}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="propertiesCount" className="text-sm font-medium text-brand-deep">
            {t('propertiesCount')}
          </label>
          <input
            id="propertiesCount"
            type="number"
            min={0}
            inputMode="numeric"
            placeholder={t('propertiesCountPlaceholder')}
            aria-invalid={Boolean(errors.propertiesCount)}
            aria-describedby={errors.propertiesCount ? 'propertiesCount-error' : undefined}
            className={cn('mt-1.5', fieldClasses(Boolean(errors.propertiesCount)))}
            {...register('propertiesCount')}
          />
          {errors.propertiesCount ? (
            <p id="propertiesCount-error" className="mt-1 text-xs text-red-600">
              {t('errors.propertiesCountInvalid')}
            </p>
          ) : null}
        </div>
      </div>

      <div>
        <label htmlFor="message" className="text-sm font-medium text-brand-deep">
          {t('message')}
        </label>
        <textarea
          id="message"
          rows={4}
          placeholder={t('messagePlaceholder')}
          aria-invalid={Boolean(errors.message)}
          aria-describedby={errors.message ? 'message-error' : undefined}
          className={cn('mt-1.5 resize-none', fieldClasses(Boolean(errors.message)))}
          {...register('message')}
        />
        {errors.message ? (
          <p id="message-error" className="mt-1 text-xs text-red-600">
            {messageValue?.trim().length ? t('errors.messageTooShort') : t('errors.messageRequired')}
          </p>
        ) : null}
      </div>

      <div>
        <label className="flex items-start gap-2.5 text-sm text-slate-600">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-green focus:ring-brand-green/30"
            aria-invalid={Boolean(errors.acceptsPrivacy)}
            aria-describedby={errors.acceptsPrivacy ? 'privacy-error' : undefined}
            {...register('acceptsPrivacy')}
          />
          <span>
            {t('privacyLabel')} —{' '}
            <Link href="/privacidad" className="font-medium text-brand-green underline underline-offset-2">
              {t('privacyLinkText')}
            </Link>
          </span>
        </label>
        {errors.acceptsPrivacy ? (
          <p id="privacy-error" className="mt-1 text-xs text-red-600">
            {t('errors.privacyRequired')}
          </p>
        ) : null}
      </div>

      {status === 'error_not_configured' || status === 'error_default' ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3.5">
          <p className="text-sm font-semibold text-red-700">{t('errorTitle')}</p>
          <p className="mt-1 text-sm text-red-600">
            {status === 'error_not_configured' ? t('errorMessageNotConfigured') : t('errorMessageDefault')}
          </p>
        </div>
      ) : null}

      <Button type="submit" size="lg" disabled={isSubmitting} className="w-full sm:w-auto">
        {isSubmitting || status === 'submitting' ? t('submitting') : t('submit')}
      </Button>
    </form>
  )
}
