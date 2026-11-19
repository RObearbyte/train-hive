import type { LegalConfig } from '../config';
import {
  FEATURES,
  LEGAL_DOC_TITLES,
  LEGAL_LAST_UPDATED,
  MINIMUM_AGE,
  PRIVACY_VERSION,
  RETENTION,
  SUPERVISORY_AUTHORITY,
  type LegalFeatures,
} from '../constants';
import type { LegalDocument } from './types';

/**
 * The Privacy Notice (Art. 13 GDPR), in plain English. A draft: it is to be
 * reviewed by a lawyer before launch (see LEGAL_REVIEWED). The controller's
 * identity comes from `config` only. Only features that exist are described: a section
 * about a later-phase feature appears only when its flag in `features` is true.
 */
export function buildPrivacyNotice(
  config: LegalConfig,
  features: LegalFeatures = FEATURES,
): LegalDocument {
  const optionalConsents =
    features.demographics || features.emergencyContact || features.workoutLogs;
  return {
    kind: 'privacy',
    title: LEGAL_DOC_TITLES.privacy,
    version: PRIVACY_VERSION,
    lastUpdated: LEGAL_LAST_UPDATED,
    intro:
      'This notice explains what TrainHive does with your information, why, who can see it, how long we keep it and what your rights are. We wrote it to be read, not to hide things.',
    sections: [
      {
        id: 'controller',
        heading: 'Who is responsible for your data',
        blocks: [
          {
            type: 'paragraph',
            text: 'The controller (the person or organization that decides how your data is used) is:',
          },
          {
            type: 'facts',
            rows: [
              { label: 'Name', value: config.controllerName },
              { label: 'Address', value: config.controllerAddress },
              { label: 'Privacy contact', value: config.privacyEmail },
            ],
          },
          {
            type: 'paragraph',
            text: 'The organizers of your community use TrainHive to run their training group. They are users of the service, not separate controllers of the platform, and they are bound by the Terms of Use to handle member information only for running their community.',
          },
        ],
      },
      {
        id: 'what-we-collect',
        heading: 'What we collect, why, and on what legal basis',
        blocks: [
          {
            type: 'paragraph',
            text: 'We collect only what the app needs. Each line below says what the data is, what it is for and the legal basis (the reason the law allows us to use it).',
          },
          {
            type: 'facts',
            rows: [
              {
                label: 'Anonymous account, community membership and role',
                value:
                  'To run the service and decide what you may see and do. Basis: contract (providing TrainHive to you).',
              },
              {
                label: 'Display name',
                value:
                  'So members of your community can recognize each other. Basis: contract. Use a nickname if you prefer.',
              },
              {
                label:
                  'Answers to training invitations (RSVP), attendance records and the change history of attendance',
                value:
                  'To plan trainings and record who took part. Basis: contract, and the legitimate interest of the community in keeping an attendance history. You may object to this at any time (see your rights below).',
              },
              features.eventPosts
                ? {
                    label: 'Announcements, posts and replies in event discussions',
                    value: 'To let members communicate about events. Basis: contract.',
                  }
                : {
                    label: 'Announcements organizers publish',
                    value:
                      'The text of announcements that organizers publish to their community, so members can read them. Basis: contract.',
                  },
              {
                label: 'Push notification token, notification settings and in-app notifications',
                value:
                  'To deliver reminders and updates. Push messages need your consent (and the permission of your phone). In-app notifications are part of the service. Basis: consent for push, contract for in-app notifications.',
              },
              ...(features.demographics
                ? [
                    {
                      label: 'Birth year and gender (optional)',
                      value:
                        'Only if you choose to give them, to produce statistics for your community. Basis: your explicit consent, which you can withdraw at any time.',
                    },
                  ]
                : []),
              ...(features.emergencyContact
                ? [
                    {
                      label: 'Emergency contact and T-shirt size (optional)',
                      value:
                        'Only if you choose to give them, for safety at events and for race kits. The emergency contact is another person: please tell them you gave their details. Basis: your explicit consent.',
                    },
                  ]
                : []),
              ...(features.workoutLogs
                ? [
                    {
                      label: 'Workout logs (optional)',
                      value:
                        'Exercises, weights, distance, time, pace and notes you choose to record, for your own progress and for community totals. Because this can reveal health-related information, we treat it as special-category data. Basis: your explicit consent, which you can withdraw at any time.',
                    },
                  ]
                : []),
              {
                label: 'Technical data held by our providers',
                value:
                  "Internet addresses and server logs created when your device talks to our providers. Basis: the providers' legitimate interest in running and securing their services, covered by their data processing terms with us.",
              },
            ],
          },
          {
            type: 'paragraph',
            text: 'We do not collect your precise location, your contacts, advertising identifiers or payment details, and we do not collect data from children.',
          },
        ],
      },
      {
        id: 'who-sees',
        heading: 'Who can see your data',
        blocks: [
          {
            type: 'list',
            items: [
              'Members of your community see your display name and, in event pages, whether you said you are going.',
              "Organizers of your community can change members' roles and remove a member from the community. A member can also leave at any time. Removed and departed members lose access, and their attendance history stays in the community's records. Removal is final for that account: a removed member cannot rejoin that community with an invitation code.",
              'Organizers of your community also see your membership, your RSVPs and your attendance records.',
              ...(features.emergencyContact
                ? [
                    'Your emergency contact and T-shirt size are visible to organizers of your community only if you consented to share them.',
                  ]
                : []),
              ...(features.demographics
                ? [
                    'Birth year and gender are never shown to organizers one by one. Organizers see only grouped statistics, and only for groups of 5 or more people.',
                  ]
                : []),
              ...(features.workoutLogs
                ? ['Workout logs are private to you. Organizers and members see only group totals.']
                : []),
              'We do not sell your data and we do not share it for advertising.',
            ],
          },
        ],
      },
      {
        id: 'recipients',
        heading: 'Companies that process data for us',
        blocks: [
          {
            type: 'paragraph',
            text: 'We use these processors (companies that handle data on our behalf and under our instructions):',
          },
          {
            type: 'list',
            items: [
              'Supabase: database, authentication and server functions. All TrainHive data is stored there.',
              'Expo (push notification service) and Google Firebase Cloud Messaging: delivery of push messages. They receive your push token and the text of the notification.',
              'The hosting provider of the web version of TrainHive: serves the website files.',
            ],
          },
          ...(features.workoutLogs || features.emergencyContact
            ? [
                {
                  type: 'paragraph' as const,
                  text: `Notification texts never contain ${
                    features.workoutLogs && features.emergencyContact
                      ? 'workout data or emergency contact details'
                      : features.workoutLogs
                        ? 'workout data'
                        : 'emergency contact details'
                  }.`,
                },
              ]
            : []),
        ],
      },
      {
        id: 'transfers',
        heading: 'Transfers outside the European Economic Area',
        blocks: [
          {
            type: 'paragraph',
            text: "Expo and Google may process push notification data outside the European Economic Area, including in the United States. Where this happens it relies on safeguards required by the GDPR, such as the European Commission's standard contractual clauses or the EU-US Data Privacy Framework. You can avoid this completely by not turning on push notifications: everything still appears inside the app.",
          },
        ],
      },
      {
        id: 'retention',
        heading: 'How long we keep data',
        blocks: [
          {
            type: 'list',
            items: [
              `In-app notifications: deleted once they are more than ${RETENTION.readNotificationsDays} days old if you have read them, and once they are more than ${RETENTION.unreadNotificationsDays} days old if you never read them.`,
              `Records of failed code attempts (used to stop guessing): deleted after ${RETENTION.failedAttemptsHours} hours.`,
              'Push device identifiers (tokens): deleted when you turn push notifications off, when you delete your account, and when a device stops working, within 30 days.',
              `Account data (name, membership, RSVPs, attendance${features.eventPosts ? ', posts' : ''}${optionalConsents ? ', optional data you gave' : ''}, your consent records): kept until you delete your account. When you delete it, attendance counts and the attendance change history stay without your name or identifier.`,
              'Consent records are kept as proof of what you agreed to and when, for as long as your account exists.',
            ],
          },
        ],
      },
      {
        id: 'rights',
        heading: 'Your rights',
        blocks: [
          {
            type: 'paragraph',
            text: 'You have the right to: see the data we hold about you (access); correct it (rectification); have it deleted (erasure); ask us to limit its use (restriction); object to uses based on legitimate interest; receive your data in a portable format; and withdraw a consent at any time. Withdrawing a consent does not affect what was done before you withdrew.',
          },
          {
            type: 'paragraph',
            text: 'How to use them:',
          },
          {
            type: 'list',
            items: [
              optionalConsents
                ? 'Withdraw or give consent: Profile, then Privacy. Each optional consent has its own switch, and turning one off takes effect at once.'
                : 'Withdraw or give consent: Profile, then Privacy. Push notifications have their own switch, and turning it off takes effect at once.',
              'Correct your name: Profile, then Change name.',
              'Download your data: Profile, then Privacy, then Download my data. You get a file with the data we hold about you. You can do this up to 10 times per hour.',
              'Delete your account: Profile, then Privacy, then Delete my account. This deletes your profile, memberships, RSVPs, notifications, push devices and consent records, and it cannot be undone. Attendance counts and the attendance change history stay without your name or any link to you, so past statistics stay correct, and announcements you published stay visible to your community; after you delete your account they are no longer linked to you. In a very small community these anonymous counts can still point to a person. If you are the only organizer of a community that still has other members, hand over to another organizer first (Profile, then Members). A community in which you are the only member is deleted together with your account.',
              'Leave a community: Profile, then Leave this community. You lose access to it, and your attendance history stays in its records until you delete your account.',
              `Restrict or object to processing: contact us at ${config.privacyEmail}. Because accounts are anonymous, we can only act on a request if you can show that the account is yours, for example by creating a code inside the app when we ask.`,
              'We answer within one month.',
            ],
          },
          {
            type: 'paragraph',
            text: `You also have the right to complain to the supervisory authority: ${SUPERVISORY_AUTHORITY.name}, ${SUPERVISORY_AUTHORITY.website}.`,
          },
        ],
      },
      {
        id: 'security',
        heading: 'How we protect your data',
        blocks: [
          {
            type: 'list',
            items: [
              'Every data table is protected by row-level security: the database itself decides who may read what.',
              'All changes go through server functions that check permissions, so the app cannot bypass the rules.',
              'Data is encrypted in transit. The app contains no administrator keys.',
              'Attendance changes are written to an audit log, and the service limits repeated attempts to guess codes.',
              'Your session on this phone is kept in the secure storage of the device where the system provides one.',
            ],
          },
          {
            type: 'paragraph',
            text: 'No system is perfectly secure. If a breach puts your rights at risk we will notify the authority and the people affected as the law requires.',
          },
        ],
      },
      {
        id: 'children',
        heading: 'Children',
        blocks: [
          {
            type: 'paragraph',
            text: `TrainHive is for people aged ${MINIMUM_AGE} or older. You confirm your age when you start. If you are younger you must not use the app, and if we learn that someone younger has an account we will delete it.`,
          },
        ],
      },
      {
        id: 'anonymous',
        heading: 'Anonymous accounts',
        blocks: [
          {
            type: 'paragraph',
            text: 'TrainHive has no email address or password. Your account is created on your device when you first enter an invitation code to join a community, and it is tied to that device. If you sign out, uninstall the app, clear its data or lose the phone, nobody (including us) can give the account back, and you would join again as a new member with a new invitation.',
          },
        ],
      },
      {
        id: 'tracking',
        heading: 'No analytics, advertising or tracking',
        blocks: [
          {
            type: 'paragraph',
            text: 'TrainHive contains no analytics, advertising or tracking tools, and does not build profiles about you.',
          },
        ],
      },
      {
        id: 'web',
        heading: 'Cookies and local storage on the web version',
        blocks: [
          {
            type: 'paragraph',
            text: "The web version stores only what it needs to keep you signed in: your session and a few settings, in your browser's local storage. It does not use cookies for tracking or advertising. Clearing your browser data signs you out, and an anonymous account cannot be recovered afterwards.",
          },
        ],
      },
      {
        id: 'changes',
        heading: 'Changes to this notice',
        blocks: [
          {
            type: 'paragraph',
            text: 'When we change this notice in a way that matters, the app shows you the new version and asks you to confirm it before you can join another community. The version and date are at the top of this page.',
          },
        ],
      },
    ],
  };
}
