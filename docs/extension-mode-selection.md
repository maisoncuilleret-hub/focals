# Extension Chrome - Logique de sélection du mode

## Vue d'ensemble

Le backend `focals-generate-reply` supporte 4 modes de génération :
- `initial` : Première réponse à un candidat
- `followup_soft` : Relance douce après silence
- `followup_strong` : Relance plus directe
- `prompt_reply` : Réponse guidée par instructions custom

## Règle principale

Le mode doit être déterminé par **qui a envoyé le dernier message** dans la conversation.

## Tableau de décision

| Dernier message | Contenu candidat | Mode à envoyer |
| --- | --- | --- |
| Du candidat | N'importe | `initial` |
| Du recruteur | N/A | `followup_soft` |
| Du recruteur (2ème relance) | N/A | `followup_strong` |
| N/A (instructions custom) | N/A | `prompt_reply` |

## Algorithme de détection

```javascript
function determineMode(messages, customInstructions) {
  // Si instructions custom → prompt_reply
  if (customInstructions && customInstructions.trim()) {
    return 'prompt_reply';
  }
  
  // Trouver le dernier message de la conversation
  const lastMessage = messages[messages.length - 1];
  
  // Si dernier message du candidat → initial (on répond à son message)
  if (!lastMessage.fromMe) {
    return 'initial';
  }
  
  // Si dernier message du recruteur → followup (le candidat n'a pas répondu)
  // Compter les messages du recruteur consécutifs à la fin
  let recruiterMessagesAtEnd = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].fromMe) {
      recruiterMessagesAtEnd++;
    } else {
      break;
    }
  }
  
  return recruiterMessagesAtEnd >= 2 ? 'followup_strong' : 'followup_soft';
}
```

## Cas d'usage détaillés

### Cas 1 : Le candidat vient de répondre
- Dernier message = candidat
- Mode = `initial`
- Backend génère une réponse au message du candidat

### Cas 2 : Le candidat n'a pas répondu (1ère relance)
- Dernier message = recruteur (1 seul)
- Mode = `followup_soft`
- Backend génère : "As-tu pu voir mon message précédent ?"

### Cas 3 : Toujours pas de réponse (2ème relance)
- Derniers messages = recruteur (2+)
- Mode = `followup_strong`
- Backend génère une relance plus directe

### Cas 4 : Instructions personnalisées
- L'utilisateur a tapé des instructions custom
- Mode = `prompt_reply`
- Backend suit les instructions custom

## Erreurs courantes à éviter

- ❌ NE PAS envoyer `followup_soft` quand le candidat vient de répondre → Le backend dirait "As-tu vu mon message ?" alors que le candidat vient de répondre !
- ❌ NE PAS envoyer `initial` quand le dernier message est du recruteur → Le backend attendrait une réponse à un message candidat qui n'existe pas
- ✅ TOUJOURS vérifier `lastMessage.fromMe` avant de choisir le mode

---

## 🤖 Prompt Codex pour mettre à jour l'extension

Voici le prompt que tu peux utiliser directement avec Codex/GPT-4/Claude pour mettre à jour ton extension :

---

### Contexte
Je développe une extension Chrome "Smart Reply" pour LinkedIn qui génère des réponses automatiques via un backend Supabase Edge Function (`focals-generate-reply`).

### Problème actuel
L'extension envoie actuellement un mode fixe ou mal calculé au backend. Exemple : elle envoie `mode: "followup_soft"` alors que le candidat vient de répondre, ce qui génère des réponses incohérentes comme "As-tu vu mon message ?" quand le candidat vient de dire "Oui je suis dispo en janvier".

### Logique à implémenter
Le mode doit être déterminé dynamiquement selon qui a envoyé le **dernier** message :

#### Règles de sélection du mode :
- Si l'utilisateur a fourni des instructions custom (`promptReply` ou `customInstructions` non vide) : → mode = `prompt_reply`
- Si le dernier message est du candidat (`fromMe === false`) : → mode = `initial` (on répond à son message)
- Si le dernier message est du recruteur (`fromMe === true`) : → Le candidat n'a pas répondu, c'est une relance → Compter les messages du recruteur consécutifs à la fin :
  - 1 message recruteur sans réponse : mode = `followup_soft`
  - 2+ messages recruteur sans réponse : mode = `followup_strong`

#### Code de référence :

```javascript
function determineMode(messages, customInstructions) {
  // Priorité aux instructions custom
  if (customInstructions && customInstructions.trim()) {
    return 'prompt_reply';
  }
  
  if (!messages || messages.length === 0) {
    return 'initial';
  }
  
  const lastMessage = messages[messages.length - 1];
  
  // Dernier message du candidat → on répond à son message
  if (!lastMessage.fromMe) {
    return 'initial';
  }
  
  // Dernier message du recruteur → relance
  // Compter les messages recruteur consécutifs à la fin
  let recruiterCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].fromMe) {
      recruiterCount++;
    } else {
      break;
    }
  }
  
  return recruiterCount >= 2 ? 'followup_strong' : 'followup_soft';
}
```

#### Structure du payload envoyé au backend :

```json
{
  "messages": [
    { "text": "...", "fromMe": true, "timestampRaw": "..." },
    { "text": "...", "fromMe": false, "timestampRaw": "..." }
  ],
  "context": {
    "mode": determineMode(messages, customInstructions), // ← CALCULÉ DYNAMIQUEMENT
    "language": "fr",
    "tone": "warm",
    "candidateName": "Anaël",
    "linkedinProfile": { ... },
    "systemPromptOverride": "..." // optionnel
  }
}
```

#### Ta mission :
- Trouve où le mode est actuellement défini dans le code de l'extension
- Remplace la logique par la fonction `determineMode()` ci-dessus
- Assure-toi que le mode est calculé **JUSTE AVANT** d'envoyer la requête au backend
- Ajoute un console.log pour debug : `console.log('[Smart Reply] Mode determined:', mode, 'Last message fromMe:', lastMessage?.fromMe)`

#### Fichiers probablement concernés :
- Le fichier qui appelle `focals-generate-reply` (content script ou background)
- Le fichier qui construit le payload de la requête
