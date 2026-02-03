import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Candidate } from "@/types/candidate";
import { logger } from "../utils/logger";

const EXTENSION_ID = "kekhkaclmlnmijnpekcpppnnoooodaca";

interface SendConnectionParams {
  candidate: Candidate;
  message: string;
}

declare global {
  interface Window {
    chrome?: {
      runtime?: {
        sendMessage: (
          extensionId: string,
          message: any,
          callback: (response: any) => void
        ) => void;
        lastError?: { message: string };
      };
    };
  }
}

const truncateMessage = (message: string) => (message || "").trim().slice(0, 300);

export const useSendLinkedInConnectionViaExtension = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ candidate, message }: SendConnectionParams) => {
      const safeMessage = truncateMessage(message);

      if (!window.chrome?.runtime?.sendMessage) {
        throw new Error("EXTENSION_NOT_AVAILABLE");
      }

      return new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("TIMEOUT"));
        }, 30000);

        window.chrome!.runtime!.sendMessage(
          EXTENSION_ID,
          {
            type: "SEND_LINKEDIN_CONNECTION",
            linkedinUrl: candidate.linkedinUrl,
            connectionMessage: safeMessage,
          },
          (response) => {
            clearTimeout(timeout);

            if (window.chrome?.runtime?.lastError) {
              reject(new Error("EXTENSION_ERROR"));
              return;
            }

            if (!response) {
              reject(new Error("NO_RESPONSE"));
              return;
            }

            if (!response.success) {
              reject(new Error(response.error || "UNKNOWN_ERROR"));
              return;
            }

            resolve(response);
          }
        );
      });
    },
    onSuccess: async (_, { candidate, message }) => {
      const safeMessage = truncateMessage(message);
      try {
        await supabase.from("activities").insert({
          profile_id: candidate.id,
          type: "linkedin_add",
          content: `Demande de connexion envoyée avec message : "${safeMessage.substring(0, 100)}${
            safeMessage.length > 100 ? "..." : ""
          }"`,
          date: new Date().toISOString().split("T")[0],
        });

        queryClient.invalidateQueries({ queryKey: ["profiles"] });
        queryClient.invalidateQueries({ queryKey: ["activities", candidate.id] });

        toast({
          title: "✅ Invitation envoyée",
          description: `Demande de connexion envoyée à ${candidate.name}`,
        });
      } catch (error) {
        logger.error("NET", "Erreur mise à jour Supabase", error);
      }
    },
    onError: (error: Error) => {
      const errorMessages: Record<string, string> = {
        EXTENSION_NOT_AVAILABLE: "L'extension Focals n'est pas installée ou n'est pas active",
        EXTENSION_ERROR: "Erreur de communication avec l'extension. Vérifiez qu'elle est installée et active.",
        NO_RESPONSE: "L'extension n'a pas répondu. Rechargez la page et réessayez.",
        TIMEOUT: "La demande a pris trop de temps. Vérifiez votre connexion LinkedIn.",
        CONNECT_BUTTON_NOT_FOUND: "Le bouton 'Se connecter' n'a pas été trouvé sur le profil",
        ALREADY_CONNECTED: "Vous êtes déjà connecté avec ce candidat",
        ALREADY_PENDING: "Une invitation est déjà en attente pour ce candidat",
        SEND_BUTTON_NOT_FOUND: "Le bouton d'envoi n'a pas été trouvé. Réessayez.",
      };

      toast({
        title: "❌ Erreur d'envoi",
        description: errorMessages[error.message] || error.message,
        variant: "destructive",
      });
    },
  });
};
