import type { LegalConfig } from '../config';
import {
  FEATURES,
  LEGAL_DOC_TITLES,
  LEGAL_LAST_UPDATED,
  MINIMUM_AGE,
  TERMS_VERSION,
  type LegalFeatures,
} from '../constants';
import type { LegalDocument } from './types';

/**
 * The Terms of Use, in plain English. A draft: it is to be reviewed by a
 * lawyer before launch (see LEGAL_REVIEWED). The operator's identity comes
 * from `config` only.
 */
export function buildTerms(config: LegalConfig, features: LegalFeatures = FEATURES): LegalDocument {
  return {
    kind: 'terms',
    title: LEGAL_DOC_TITLES.terms,
    version: TERMS_VERSION,
    lastUpdated: LEGAL_LAST_UPDATED,
    intro:
      'These rules apply when you use TrainHive. They are short on purpose. Please read them together with the Privacy Notice.',
    sections: [
      {
        id: 'who',
        heading: 'Who we are and what TrainHive is',
        blocks: [
          {
            type: 'paragraph',
            text: `TrainHive is a service for sports groups to plan events, answer invitations, record attendance and ${features.eventPosts ? 'talk to each other' : 'share announcements'}. It is operated by ${config.controllerName}, ${config.controllerAddress}. You can reach us at ${config.privacyEmail}.`,
          },
        ],
      },
      {
        id: 'accepting',
        heading: 'Using TrainHive',
        blocks: [
          {
            type: 'list',
            items: [
              `You must be at least ${MINIMUM_AGE} years old.`,
              'You join a community with an invitation code from its organizer. You may belong to several communities.',
              'By ticking the box on the start screen you confirm that you have read these Terms and the Privacy Notice and that you accept the Terms.',
              features.accountLinking
                ? 'Your account is anonymous and tied to your device unless you add an email address (optional, in your profile). Keep your device safe: we cannot recover an account without a linked email that has been signed out or lost. With a linked email you can sign in again on another device with a 6-digit code we send to it.'
                : 'Your account is anonymous and tied to your device. Keep your device safe: we cannot recover an account that has been signed out or lost.',
              ...(features.accountLinking
                ? ['Add only an email address that is yours, and keep access to it: whoever can read its sign-in codes can sign in to your account.']
                : []),
            ],
          },
        ],
      },
      {
        id: 'acceptable-use',
        heading: 'Acceptable use',
        blocks: [
          {
            type: 'paragraph',
            text: 'Be a good training partner. You agree not to:',
          },
          {
            type: 'list',
            items: [
              'break the law or encourage others to;',
              'harass, threaten, insult or discriminate against anyone;',
              'pretend to be someone else or give a misleading name to deceive people;',
              'try to guess codes, break into other accounts, or interfere with how the service works;',
              'use automated tools to collect data from TrainHive;',
              'upload malicious code.',
            ],
          },
        ],
      },
      {
        id: 'organizers',
        heading: 'Organizers',
        blocks: [
          {
            type: 'paragraph',
            text: 'Organizers can see more member information than other members (for example RSVPs and attendance). If you are an organizer you agree to:',
          },
          {
            type: 'list',
            items: [
              "use members' information only to run your community and its events;",
              'not copy, export, publish or share it, inside or outside TrainHive, except where the law requires it;',
              'not use it to contact members for anything unrelated to the community;',
              'correct a record when a member reasonably asks you to, and pass on to us any request to delete information;',
              ...(features.emergencyContact
                ? [
                    'treat optional information members have shared (such as an emergency contact and T-shirt size) with particular care: use it only for safety at events and for race kits, and keep it confidential.',
                  ]
                : []),
            ],
          },
        ],
      },
      {
        id: 'content',
        heading: 'What you post',
        blocks: [
          {
            type: 'paragraph',
            text: `You are responsible for the ${features.eventPosts ? 'posts and replies' : 'announcements'} you write. Post only what you are entitled to share, and keep it respectful and relevant to the community. Do not post other people's private information, and keep health details out of posts. Organizers may cancel an announcement that has not been sent yet if it breaks these rules.${features.eventPosts ? ' Posts and replies in an event discussion are visible to the active members of the community, and the first part of their text can appear in notifications on their phones. Organizers may delete any post or reply that breaks these rules, and you can delete your own replies.' : ''} You keep your rights in what you write, and you allow TrainHive to store it and show it to your community so the service can work.`,
          },
        ],
      },
      {
        id: 'availability',
        heading: 'Availability',
        blocks: [
          {
            type: 'paragraph',
            text: 'We work to keep TrainHive running, but we provide it as it is and as available, without a promise that it will be uninterrupted or free of errors. Notifications and reminders may arrive late or not at all, so please do not rely on them alone for anything important. We may change or stop features, and we will try to tell you when a change matters.',
          },
        ],
      },
      {
        id: 'liability',
        heading: 'Responsibility and liability',
        blocks: [
          {
            type: 'paragraph',
            text: 'Sports carry risk. Events are organized by your community, not by TrainHive, and taking part is your own decision. To the extent the law allows, we are not liable for what happens at events, for decisions organizers or members make, or for indirect or consequential losses arising from your use of the service. Nothing in these Terms limits liability that cannot be limited by law, such as liability for intent or gross negligence, or for death or personal injury caused by negligence, and nothing limits your rights as a consumer.',
          },
        ],
      },
      {
        id: 'termination',
        heading: 'Ending your use',
        blocks: [
          {
            type: 'paragraph',
            text: 'You can stop using TrainHive at any time. You can delete your account in the app (Profile, then Privacy, then Delete my account), or leave a single community from your Profile. We may suspend or end access for someone who seriously or repeatedly breaks these Terms, and an organizer may remove a member from their community. A removed member cannot rejoin with an invitation code: removal is final for that account in this version of TrainHive, and that member loses access to the community and its history.',
          },
        ],
      },
      {
        id: 'changes',
        heading: 'Changes to these Terms',
        blocks: [
          {
            type: 'paragraph',
            text: 'We may update these Terms. When we do, the app shows the new version and asks you to confirm it before you can join another community. The version and date are at the top of this page.',
          },
        ],
      },
      {
        id: 'law',
        heading: 'Governing law and contact',
        blocks: [
          {
            type: 'paragraph',
            text: 'These Terms are governed by the law of Romania. If you are a consumer, you also keep the protection of the mandatory rules of the country where you live. Questions about these Terms: write to the contact above.',
          },
        ],
      },
    ],
  };
}
