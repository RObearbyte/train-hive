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

/** `attendance_audit_log.action` (a text column with a check constraint, not an enum). */
export type AttendanceAuditAction = 'record' | 'correct' | 'walk_in_add';

/** `device_push_tokens.platform` (text with a check constraint). */
export type PushPlatform = 'ios' | 'android' | 'web';

/** `notification_delivery_jobs.status` (text with a check constraint). */
export type NotificationJobStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'dead' | 'skipped';

/** `p_status` of `complete_notification_job`. */
export type NotificationJobOutcome = 'sent' | 'skipped' | 'failed' | 'dead';

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
          organizer_id: string | null;
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
          // M2. The server always returns both. Optional only until the session fixtures in
          // src/**/*.test.ts (mobile / QA lane) include them; then make them required.
          attendance_finalized_at?: string | null;
          attendance_finalized_by?: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          organizer_id?: string | null;
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
          attendance_finalized_at?: string | null;
          attendance_finalized_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          organizer_id?: string | null;
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
          attendance_finalized_at?: string | null;
          attendance_finalized_by?: string | null;
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
          {
            foreignKeyName: 'training_sessions_attendance_finalized_by_fkey';
            columns: ['attendance_finalized_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      attendance_records: {
        Row: {
          id: string;
          session_id: string;
          community_id: string;
          user_id: string;
          status: Database['public']['Enums']['attendance_status'];
          recorded_by: string | null;
          recorded_at: string;
          updated_at: string;
          had_rsvp_going: boolean;
          is_walk_in: boolean;
        };
        Insert: {
          id?: string;
          session_id: string;
          community_id: string;
          user_id: string;
          status?: Database['public']['Enums']['attendance_status'];
          recorded_by?: string | null;
          recorded_at?: string;
          updated_at?: string;
          had_rsvp_going: boolean;
          is_walk_in?: boolean;
        };
        Update: {
          id?: string;
          session_id?: string;
          community_id?: string;
          user_id?: string;
          status?: Database['public']['Enums']['attendance_status'];
          recorded_by?: string | null;
          recorded_at?: string;
          updated_at?: string;
          had_rsvp_going?: boolean;
          is_walk_in?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: 'attendance_records_session_fkey';
            columns: ['session_id', 'community_id'];
            isOneToOne: false;
            referencedRelation: 'training_sessions';
            referencedColumns: ['id', 'community_id'];
          },
          {
            foreignKeyName: 'attendance_records_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'attendance_records_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'attendance_records_recorded_by_fkey';
            columns: ['recorded_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      attendance_audit_log: {
        Row: {
          id: string;
          session_id: string;
          community_id: string;
          user_id: string;
          changed_by: string | null;
          changed_at: string;
          old_status: Database['public']['Enums']['attendance_status'];
          new_status: Database['public']['Enums']['attendance_status'];
          reason: string | null;
          action: AttendanceAuditAction;
        };
        Insert: {
          id?: string;
          session_id: string;
          community_id: string;
          user_id: string;
          changed_by?: string | null;
          changed_at?: string;
          old_status: Database['public']['Enums']['attendance_status'];
          new_status: Database['public']['Enums']['attendance_status'];
          reason?: string | null;
          action: AttendanceAuditAction;
        };
        Update: {
          id?: string;
          session_id?: string;
          community_id?: string;
          user_id?: string;
          changed_by?: string | null;
          changed_at?: string;
          old_status?: Database['public']['Enums']['attendance_status'];
          new_status?: Database['public']['Enums']['attendance_status'];
          reason?: string | null;
          action?: AttendanceAuditAction;
        };
        Relationships: [
          {
            foreignKeyName: 'attendance_audit_log_session_fkey';
            columns: ['session_id', 'community_id'];
            isOneToOne: false;
            referencedRelation: 'training_sessions';
            referencedColumns: ['id', 'community_id'];
          },
          {
            foreignKeyName: 'attendance_audit_log_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'attendance_audit_log_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'attendance_audit_log_changed_by_fkey';
            columns: ['changed_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
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
      announcements: {
        Row: {
          id: string;
          community_id: string;
          /** null once the author's account is deleted. */
          author_id: string | null;
          title: string;
          body: string;
          status: Database['public']['Enums']['announcement_status'];
          scheduled_for: string | null;
          published_at: string | null;
          cancelled_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          author_id?: string | null;
          title: string;
          body: string;
          status: Database['public']['Enums']['announcement_status'];
          scheduled_for?: string | null;
          published_at?: string | null;
          cancelled_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          author_id?: string | null;
          title?: string;
          body?: string;
          status?: Database['public']['Enums']['announcement_status'];
          scheduled_for?: string | null;
          published_at?: string | null;
          cancelled_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'announcements_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'announcements_author_id_fkey';
            columns: ['author_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      announcement_reads: {
        Row: { announcement_id: string; user_id: string; read_at: string };
        Insert: { announcement_id: string; user_id: string; read_at?: string };
        Update: { announcement_id?: string; user_id?: string; read_at?: string };
        Relationships: [
          {
            foreignKeyName: 'announcement_reads_announcement_id_fkey';
            columns: ['announcement_id'];
            isOneToOne: false;
            referencedRelation: 'announcements';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'announcement_reads_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      notifications: {
        Row: {
          id: string;
          /** No foreign key (see the contract); always the recipient. */
          user_id: string;
          community_id: string;
          kind: Database['public']['Enums']['notification_kind'];
          title: string;
          body: string;
          /** Relative app route: `/trainings/<id>` or `/announcements/<id>`. */
          deep_link: string;
          related_session_id: string | null;
          related_announcement_id: string | null;
          dedupe_key: string;
          created_at: string;
          read_at: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          community_id: string;
          kind: Database['public']['Enums']['notification_kind'];
          title: string;
          body: string;
          deep_link: string;
          related_session_id?: string | null;
          related_announcement_id?: string | null;
          dedupe_key: string;
          created_at?: string;
          read_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          community_id?: string;
          kind?: Database['public']['Enums']['notification_kind'];
          title?: string;
          body?: string;
          deep_link?: string;
          related_session_id?: string | null;
          related_announcement_id?: string | null;
          dedupe_key?: string;
          created_at?: string;
          read_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'notifications_community_id_fkey';
            columns: ['community_id'];
            isOneToOne: false;
            referencedRelation: 'communities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notifications_related_session_id_fkey';
            columns: ['related_session_id'];
            isOneToOne: false;
            referencedRelation: 'training_sessions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notifications_related_announcement_id_fkey';
            columns: ['related_announcement_id'];
            isOneToOne: false;
            referencedRelation: 'announcements';
            referencedColumns: ['id'];
          },
        ];
      };
      /** No client access at all (no grant, no policy). Listed for the service-role dispatcher. */
      notification_delivery_jobs: {
        Row: {
          id: string;
          notification_id: string;
          user_id: string;
          status: NotificationJobStatus;
          attempts: number;
          max_attempts: number;
          next_attempt_at: string;
          expires_at: string;
          last_error: string | null;
          locked_at: string | null;
          locked_by: string | null;
          created_at: string;
          sent_at: string | null;
        };
        Insert: {
          id?: string;
          notification_id: string;
          user_id: string;
          status?: NotificationJobStatus;
          attempts?: number;
          max_attempts?: number;
          next_attempt_at?: string;
          expires_at: string;
          last_error?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          created_at?: string;
          sent_at?: string | null;
        };
        Update: {
          id?: string;
          notification_id?: string;
          user_id?: string;
          status?: NotificationJobStatus;
          attempts?: number;
          max_attempts?: number;
          next_attempt_at?: string;
          expires_at?: string;
          last_error?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          created_at?: string;
          sent_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'notification_delivery_jobs_notification_id_fkey';
            columns: ['notification_id'];
            isOneToOne: true;
            referencedRelation: 'notifications';
            referencedColumns: ['id'];
          },
        ];
      };
      device_push_tokens: {
        Row: {
          id: string;
          user_id: string;
          token: string;
          platform: PushPlatform;
          device_label: string | null;
          created_at: string;
          last_seen_at: string;
          invalidated_at: string | null;
          last_error: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          token: string;
          platform: PushPlatform;
          device_label?: string | null;
          created_at?: string;
          last_seen_at?: string;
          invalidated_at?: string | null;
          last_error?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          token?: string;
          platform?: PushPlatform;
          device_label?: string | null;
          created_at?: string;
          last_seen_at?: string;
          invalidated_at?: string | null;
          last_error?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'device_push_tokens_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      notification_preferences: {
        Row: {
          user_id: string;
          push_enabled: boolean;
          training_reminders: boolean;
          announcements: boolean;
          training_updates: boolean;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          push_enabled?: boolean;
          training_reminders?: boolean;
          announcements?: boolean;
          training_updates?: boolean;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          push_enabled?: boolean;
          training_reminders?: boolean;
          announcements?: boolean;
          training_updates?: boolean;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notification_preferences_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
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
      /** Organizer only. `p_user_id` is the attendee, not the caller. */
      record_attendance: {
        Args: {
          p_session_id: string;
          p_user_id: string;
          p_status: Database['public']['Enums']['attendance_status'];
          p_reason?: string | null;
        };
        Returns: Database['public']['Tables']['attendance_records']['Row'];
      };
      /** Organizer only. `p_user_id` is the attendee, not the caller. */
      add_walk_in_attendee: {
        Args: { p_session_id: string; p_user_id: string };
        Returns: Database['public']['Tables']['attendance_records']['Row'];
      };
      /** Organizer only. */
      finalize_attendance: {
        Args: { p_session_id: string };
        Returns: Database['public']['Tables']['training_sessions']['Row'];
      };
      /** Organizer only. Returns an `AttendanceSheet`. */
      get_attendance_sheet: {
        Args: { p_session_id: string };
        Returns: Json;
      };
      /** Organizer only. `p_scheduled_for` null = publish now. */
      create_announcement: {
        Args: {
          p_community_id: string;
          p_title: string;
          p_body: string;
          p_scheduled_for?: string | null;
        };
        Returns: Database['public']['Tables']['announcements']['Row'];
      };
      /** Organizer only, while `scheduled`. `p_scheduled_for` null = publish now. */
      update_announcement: {
        Args: { p_id: string; p_title: string; p_body: string; p_scheduled_for: string | null };
        Returns: Database['public']['Tables']['announcements']['Row'];
      };
      /** Organizer only, while `scheduled`; idempotent. */
      cancel_announcement: {
        Args: { p_id: string };
        Returns: Database['public']['Tables']['announcements']['Row'];
      };
      /** service_role only; scheduled by pg_cron. */
      publish_due_announcements: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      mark_announcement_read: {
        Args: { p_id: string };
        Returns: Database['public']['Tables']['announcement_reads']['Row'];
      };
      /** Returns the number of announcements newly marked read. */
      mark_announcements_read: {
        Args: { p_community_id: string };
        Returns: number;
      };
      unread_announcement_count: {
        Args: { p_community_id: string };
        Returns: number;
      };
      mark_notification_read: {
        Args: { p_id: string };
        Returns: Database['public']['Tables']['notifications']['Row'];
      };
      /** Returns the number of notifications newly marked read. */
      mark_all_notifications_read: {
        Args: { p_community_id: string };
        Returns: number;
      };
      /** service_role only; scheduled by pg_cron. */
      enqueue_due_training_reminders: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      register_push_token: {
        Args: { p_token: string; p_platform: PushPlatform; p_device_label?: string | null };
        Returns: Database['public']['Tables']['device_push_tokens']['Row'];
      };
      /** Returns whether a row was removed. */
      unregister_push_token: {
        Args: { p_token: string };
        Returns: boolean;
      };
      /** `updated_at` is null when the user never saved preferences (all defaults). */
      get_notification_preferences: {
        Args: Record<PropertyKey, never>;
        Returns: Omit<Database['public']['Tables']['notification_preferences']['Row'], 'updated_at'> & {
          updated_at: string | null;
        };
      };
      /** A null / omitted argument keeps the current value. */
      set_notification_preferences: {
        Args: {
          p_push_enabled?: boolean | null;
          p_training_reminders?: boolean | null;
          p_announcements?: boolean | null;
          p_training_updates?: boolean | null;
        };
        Returns: Database['public']['Tables']['notification_preferences']['Row'];
      };
      /** service_role only (push dispatcher). Returns one `ClaimedNotificationJob` per row. */
      claim_notification_jobs: {
        Args: { p_limit?: number; p_worker: string };
        Returns: Json[];
      };
      /** service_role only (push dispatcher). Returns a `CompleteNotificationJobResult`. */
      complete_notification_job: {
        Args: {
          p_job_id: string;
          p_status: NotificationJobOutcome;
          p_error?: string | null;
          p_retry_in_seconds?: number | null;
        };
        Returns: Json;
      };
      /** service_role only (push dispatcher). Returns the number of tokens newly invalidated. */
      invalidate_push_tokens: {
        Args: { p_tokens: string[]; p_error?: string | null };
        Returns: number;
      };
      /** service_role only; scheduled daily. Returns the number of rows deleted. */
      purge_old_notification_data: {
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
      attendance_status: 'present' | 'absent' | 'unrecorded';
      announcement_status: 'scheduled' | 'published' | 'cancelled';
      notification_kind:
        | 'training_created'
        | 'training_updated'
        | 'training_confirmed'
        | 'training_cancelled'
        | 'training_reminder'
        | 'announcement_published';
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
export type AttendanceRecord = Tables<'attendance_records'>;
export type AttendanceAuditEntry = Tables<'attendance_audit_log'>;

export type MembershipRole = Enums<'membership_role'>;
export type MembershipStatus = Enums<'membership_status'>;
export type SessionStatus = Enums<'session_status'>;
export type CancelReason = Enums<'cancel_reason'>;
export type RsvpResponse = Enums<'rsvp_response'>;
export type AttendanceStatus = Enums<'attendance_status'>;

export type Announcement = Tables<'announcements'>;
export type AnnouncementRead = Tables<'announcement_reads'>;
export type AppNotification = Tables<'notifications'>;
export type DevicePushToken = Tables<'device_push_tokens'>;
export type NotificationPreferences = Tables<'notification_preferences'>;
export type NotificationDeliveryJob = Tables<'notification_delivery_jobs'>;
export type AnnouncementStatus = Enums<'announcement_status'>;
export type NotificationKind = Enums<'notification_kind'>;

/** Why a claimed job has no tokens (`claim_notification_jobs`). */
export type NotificationSkipReason = 'not_a_member' | 'push_disabled' | 'category_disabled' | 'no_tokens';

/** One row of `claim_notification_jobs` (service_role dispatcher). */
export type ClaimedNotificationJob = {
  job_id: string;
  notification_id: string;
  user_id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  deep_link: string;
  community_id: string;
  related_session_id: string | null;
  related_announcement_id: string | null;
  /** Including this claim. */
  attempts: number;
  max_attempts: number;
  /** The recipient's unread in-app notifications (all communities), for the badge. */
  unread_count: number;
  push_allowed: boolean;
  skip_reason: NotificationSkipReason | null;
  /** Valid tokens, most recently seen first; empty when push is not allowed. */
  tokens: string[];
};

/** Result of `complete_notification_job`. `changed` is false for a repeated completion. */
export type CompleteNotificationJobResult = {
  job_id: string;
  status: NotificationJobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  sent_at: string | null;
  changed: boolean;
};

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

/** One line of `get_attendance_sheet`. */
export type AttendanceSheetEntry = {
  user_id: string;
  display_name: string;
  /** null when the membership row no longer exists. */
  membership_status: MembershipStatus | null;
  rsvp_response: RsvpResponse;
  /** `unrecorded` when the member has no record yet. */
  attendance_status: AttendanceStatus;
  has_record: boolean;
  is_walk_in: boolean;
  /** null when the member has no record yet. */
  had_rsvp_going: boolean | null;
  /** Last status change; null when the member has no record yet. */
  updated_at: string | null;
};

/** Result of `get_attendance_sheet`. Entries are ordered by display name. */
export type AttendanceSheet = {
  session_id: string;
  status: SessionStatus;
  /** Server-side: the session's end (or start, without an end) has passed. */
  ended: boolean;
  attendance_finalized_at: string | null;
  attendance_finalized_by: string | null;
  entries: AttendanceSheetEntry[];
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
