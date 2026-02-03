import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const EXTENSION_ID = "kekhkaclmlnmijnpekcpppnnoooodaca";

declare const chrome: any;

interface ActivityReply {
  id: string;
  profile_id: string;
  comment: string | null;
  created_at: string;
  profiles: {
    name: string;
    linkedin_url: string | null;
  };
}

export function useLinkedInReplies() {
  const queryClient = useQueryClient();
  const [extensionAvailable, setExtensionAvailable] = useState(false);

  // Vérifier si l'extension est disponible
  useEffect(() => {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage(
        EXTENSION_ID,
        { type: "FOCALS_PING" },
        (response: any) => {
          setExtensionAvailable(!!response?.pong);
        }
      );
    }
  }, []);

  // Récupérer les profils avec des réponses récentes (< 24h)
  const { data: profilesWithReplies, isLoading } = useQuery<ActivityReply[]>({
    queryKey: ["linkedin-replies"],
    queryFn: async () => {
      const twentyFourHoursAgo = new Date();
      twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

      const { data, error } = await supabase
        .from("activities")
        .select(
          `
          id,
          profile_id,
          comment,
          created_at,
          profiles!inner(name, linkedin_url)
        `
        )
        .eq("type", "linkedin_reply")
        .gte("created_at", twentyFourHoursAgo.toISOString())
        .order("created_at", { ascending: false });

      if (error) throw error;
      return data || [];
    },
    refetchInterval: 30000,
  });

  // Forcer un scan des messages LinkedIn
  const forceScan = async () => {
    if (!extensionAvailable) {
      toast.error("Extension non disponible");
      return;
    }

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        EXTENSION_ID,
        { type: "FORCE_LINKEDIN_MESSAGE_SCAN" },
        (response: any) => {
          if (response?.error) {
            toast.error(`Erreur: ${response.error}`);
            reject(new Error(response.error));
          } else {
            toast.success(`Scan terminé: ${response?.count || 0} conversations analysées`);
            queryClient.invalidateQueries({ queryKey: ["linkedin-replies"] });
            queryClient.invalidateQueries({ queryKey: ["activities"] });
            resolve(response);
          }
        }
      );
    });
  };

  // Écouter les mises à jour en temps réel
  useEffect(() => {
    const channel = supabase
      .channel("linkedin-replies")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "activities",
          filter: "type=eq.linkedin_reply",
        },
        (payload) => {
          console.log("Nouvelle réponse LinkedIn:", payload);
          queryClient.invalidateQueries({ queryKey: ["linkedin-replies"] });
          queryClient.invalidateQueries({ queryKey: ["activities"] });
          toast.success("💬 Nouvelle réponse LinkedIn détectée !");
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return {
    profilesWithReplies,
    isLoading,
    forceScan,
    extensionAvailable,
    hasNewReplies: (profilesWithReplies?.length || 0) > 0,
  };
}

export function hasRecentReply(
  profileId: string,
  replies: ActivityReply[] | undefined
): boolean {
  if (!replies) return false;
  return replies.some((r) => r.profile_id === profileId);
}
