/**
 * Hand-written mirror of docs/API_CONTRACT.md, in the shape that
 * `supabase gen types typescript` produces.
 *
 * When a hosted project exists, replace everything ABOVE the
 * "Convenience aliases" marker with the generated output and keep the
 * aliases section: callers only depend on `Database` and on the aliases.
 *
 * Timestamps (`timestamptz`) are ISO 8601 strings in UTC.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      communities: {
        Row: {
          id: string;
          name: string;
          timezone: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          timezone: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          timezone?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          display_name: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          display_name: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          display_name?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      memberships: {
        Row: {
          id: string;
          community_id: string;
          user_id: string;
          role: Database['public']['Enums']['membership_role'];
          status: Database['public']['Enums']['membership_status'];
          joined_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          user_id: string;
          role?: Database['public']['Enums']['membership_role'];
          status?: Database['public']['Enums']['membership_status'];
          joined_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          user_id?: string;
          role?: Database['public']['Enums']['membership_role'];
          status?: Database['public']['Enums']['membership_status'];
          joined_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'memberships_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'memberships_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      invitation_codes: {
        Row: {
          id: string;
          community_id: string;
          code: string;
          role: Database['public']['Enums']['membership_role'];
          created_by: string | null;
          expires_at: string | null;
          max_redemptions: number | null;
          redemption_count: number;
          revoked_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          code: string;
          role?: Database['public']['Enums']['membership_role'];
          created_by?: string | null;
          expires_at?: string | null;
          max_redemptions?: number | null;
          redemption_count?: number;
          revoked_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          code?: string;
          role?: Database['public']['Enums']['membership_role'];
          created_by?: string | null;
          expires_at?: string | null;
          max_redemptions?: number | null;
          redemption_count?: number;
          revoked_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'invitation_codes_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'invitation_codes_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      invitation_redemptions: {
        Row: {
          id: string;
          invitation_id: string;
          user_id: string;
          redeemed_at: string;
        };
        Insert: {
          id?: string;
          invitation_id: string;
          user_id: string;
          redeemed_at?: string;
        };
        Update: {
          id?: string;
          invitation_id?: string;
          user_id?: string;
          redeemed_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'invitation_redemptions_invitation_id_fkey';
            columns: ['invitation_id'];
            isOneToOne: false;
            referencedRelation: 'invitation_codes';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'invitation_redemptions_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      invitation_attempts: {
        Row: {
          id: string;
          user_id: string;
          attempted_at: string;
          success: boolean;
        };
        Insert: {
          id?: string;
          user_id: string;
          attempted_at?: string;
          success: boolean;
        };
        Update: {
          id?: string;
          user_id?: string;
          attempted_at?: string;
          success?: boolean;
        };
        Relationships: [];
      };
      activity_types: {
        Row: {
          key: string;
          label: string;
          sort_order: number;
        };
        Insert: {
          key: string;
          label: string;
          sort_order?: number;
        };
        Update: {
          key?: string;
          label?: string;
          sort_order?: number;
        };
        Relationships: [];
      };
      training_sessions: {
        Row: {
          id: string;
          community_id: string;
          organizer_id: string;
          title: string;
          description: string | null;
          activity_type: string;
          starts_at: string;
          ends_at: string | null;
          rsvp_deadline: string;
          timezone: string;
          location_name: string;
          address: string | null;
          latitude: number | null;
          longitude: number | null;
          map_url: string | null;
          meeting_instructions: string | null;
          min_participants: number;
          max_participants: number | null;
          going_count: number;
          status: Database['public']['Enums']['session_status'];
          cancel_reason: Database['public']['Enums']['cancel_reason'] | null;
          decided_at: string | null;
          cancelled_at: string | null;
          cancelled_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          organizer_id: string;
          title: string;
          description?: string | null;
          activity_type?: string;
          starts_at: string;
          ends_at?: string | null;
          rsvp_deadline: string;
          timezone: string;
          location_name: string;
          address?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          map_url?: string | null;
          meeting_instructions?: string | null;
          min_participants: number;
          max_participants?: number | null;
          going_count?: number;
          status?: Database['public']['Enums']['session_status'];
          cancel_reason?: Database['public']['Enums']['cancel_reason'] | null;
          decided_at?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          organizer_id?: string;
          title?: string;
          description?: string | null;
          activity_type?: string;
          starts_at?: string;
          ends_at?: string | null;
          rsvp_deadline?: string;
          timezone?: string;
          location_name?: string;
          address?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          map_url?: string | null;
          meeting_instructions?: string | null;
          min_participants?: number;
          max_participants?: number | null;
          going_count?: number;
          status?: Database['public']['Enums']['session_status'];
          cancel_reason?: Database['public']['Enums']['cancel_reason'] | null;
          decided_at?: string | null;
          cancelled_at?: string | null;
          cancelled_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'training_sessions_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'training_sessions_organizer_id_fkey';
            columns: ['organizer_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'training_sessions_cancelled_by_fkey';
            columns: ['cancelled_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'training_sessions_activity_type_fkey';
            columns: ['activity_type'];
            isOneToOne: false;
            referencedRelation: 'activity_types';
            referencedColumns: ['key'];
          },
        ];
      };
      training_rsvps: {
        Row: {
          id: string;
          session_id: string;
          community_id: string;
          user_id: string;
          response: Database['public']['Enums']['rsvp_response'];
          responded_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          session_id: string;
          community_id: string;
          user_id: string;
          response?: Database['public']['Enums']['rsvp_response'];
          responded_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          session_id?: string;
          community_id?: string;
          user_id?: string;
          response?: Database['public']['Enums']['rsvp_response'];
          responded_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'training_rsvps_session_fkey';
            columns: ['session_id', 'community_id'];
            isOneToOne: false;
            referencedRelation: 'training_sessions';
            referencedColumns: ['id', 'community_id'];
          },
          {
            foreignKeyName: 'training_rsvps_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'training_rsvps_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      is_active_member: {
        Args: { community_id: string };
        Returns: boolean;
      };
      is_organizer: {
        Args: { community_id: string };
        Returns: boolean;
      };
      preview_invitation: {
        Args: { p_code: string };
        Returns: Json;
      };
      redeem_invitation: {
        Args: { p_code: string; p_display_name: string };
        Returns: Json;
      };
      create_invitation: {
        Args: {
          p_community_id: string;
          p_expires_at?: string | null;
          p_max_redemptions?: number | null;
        };
        Returns: Database['public']['Tables']['invitation_codes']['Row'];
      };
      revoke_invitation: {
        Args: { p_invitation_id: string };
        Returns: Database['public']['Tables']['invitation_codes']['Row'];
      };
      /** service_role only. */
      admin_create_community: {
        Args: { p_name: string; p_timezone: string };
        Returns: Json;
      };
      update_display_name: {
        Args: { p_display_name: string };
        Returns: Database['public']['Tables']['profiles']['Row'];
      };
      create_training: {
        Args: { p_community_id: string; p_input: Json };
        Returns: Database['public']['Tables']['training_sessions']['Row'];
      };
      update_training: {
        Args: { p_session_id: string; p_input: Json };
        Returns: Database['public']['Tables']['training_sessions']['Row'];
      };
      cancel_training: {
        Args: { p_session_id: string };
        Returns: Database['public']['Tables']['training_sessions']['Row'];
      };
      set_rsvp: {
        Args: {
          p_session_id: string;
          p_response: Database['public']['Enums']['rsvp_response'];
        };
        Returns: Json;
      };
      /** service_role only; scheduled by pg_cron. */
      finalize_due_sessions: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
    };
    Enums: {
      membership_role: 'organizer' | 'member';
      membership_status: 'active' | 'removed';
      session_status: 'scheduled' | 'confirmed' | 'cancelled' | 'completed';
      cancel_reason: 'insufficient_participation' | 'organizer';
      rsvp_response: 'going' | 'not_going' | 'no_response';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

// ---------------------------------------------------------------------------
// Convenience aliases (keep this section when swapping in generated types)
// ---------------------------------------------------------------------------

type PublicSchema = Database['public'];

export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row'];
export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T];
export type FunctionArgs<T extends keyof PublicSchema['Functions']> =
  PublicSchema['Functions'][T]['Args'];
export type FunctionReturns<T extends keyof PublicSchema['Functions']> =
  PublicSchema['Functions'][T]['Returns'];

export type Community = Tables<'communities'>;
export type Profile = Tables<'profiles'>;
export type Membership = Tables<'memberships'>;
export type InvitationCode = Tables<'invitation_codes'>;
export type InvitationRedemption = Tables<'invitation_redemptions'>;
export type ActivityType = Tables<'activity_types'>;
export type TrainingSession = Tables<'training_sessions'>;
export type TrainingRsvp = Tables<'training_rsvps'>;

export type MembershipRole = Enums<'membership_role'>;
export type MembershipStatus = Enums<'membership_status'>;
export type SessionStatus = Enums<'session_status'>;
export type CancelReason = Enums<'cancel_reason'>;
export type RsvpResponse = Enums<'rsvp_response'>;

/** `{ ok: false, error }` branch shared by the invitation RPCs. `error` is a contract code. */
export type RpcFailure = { ok: false; error: string };

/** Result of `preview_invitation`. */
export type PreviewInvitationResult =
  | { ok: true; community_name: string; role: MembershipRole }
  | RpcFailure;

/** Result of `redeem_invitation`. */
export type RedeemInvitationResult =
  | {
      ok: true;
      community_id: string;
      membership_id: string;
      role: MembershipRole;
      already_member: boolean;
    }
  | RpcFailure;

/** Result of `admin_create_community` (service_role only). */
export type AdminCreateCommunityResult = { community_id: string; organizer_code: string };

/** Result of `set_rsvp`. */
export type SetRsvpResult = {
  response: RsvpResponse;
  going_count: number;
  status: SessionStatus;
};

/**
 * `p_input` of `create_training` / `update_training`. Keys are the column
 * names. Timestamps are UTC ISO strings. Optional keys may be omitted or
 * null; update is a full replace, so the client sends every key.
 */
export type TrainingInput = {
  title: string;
  description?: string | null;
  activity_type?: string | null;
  starts_at: string;
  ends_at?: string | null;
  rsvp_deadline?: string | null;
  timezone?: string | null;
  location_name: string;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  map_url?: string | null;
  meeting_instructions?: string | null;
  min_participants: number;
  max_participants?: number | null;
};
