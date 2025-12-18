/**
 * OfflineManager
 * Beheert de lokale Dexie database en synchroniseert met de DataGateway.
 * Ondersteunt automatische prefixing per app en binaire bijlagen.
 */
import DataGateway from './datagateway.js';

export default class OfflineManager {
  /**
   * @param {string} baseUrl - De URL van de API Gateway.
   * @param {string} clientId - De unieke ID van de gebruiker.
   * @param {string} appName - De naam van de applicatie (voor isolatie en prefixing).
   */
  constructor(baseUrl, clientId, appName) {
    this.appName = appName;
    this.gateway = new DataGateway(baseUrl, clientId, appName);
    
    // We maken een unieke database naam per app en per gebruiker
    this.db = new Dexie(`AppCache_${appName}_${clientId}`);
    
    // Schema definitie
    // data: de lokale kopie van de MongoDB documenten
    // outbox: acties die nog naar de server gestuurd moeten worden
    this.db.version(1).stores({
      data: "++id, collection, _id", 
      outbox: "++id, action, collection, payload"
    });
  }

  /**
   * Hulpmethode om binaire bestanden (Blob/File) om te zetten naar Base64.
   * Nodig voor verzending via de JSON API.
   * @private
   */
  _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Haalt alle documenten van een collectie op.
   * Geeft direct de lokale cache terug voor snelheid en ververst op de achtergrond.
   */
  async getSmartCollection(collectionName) {
    // 1. Haal direct op uit de lokale Dexie database
    const localData = await this.db.data
      .where({ collection: collectionName })
      .toArray();
    
    // 2. Indien online, ververs de cache op de achtergrond
    if (navigator.onLine) {
      this.refreshCache(collectionName);
    }
    
    return localData;
  }

  /**
   * Haalt één specifiek document op via ID.
   * Zoekt eerst lokaal; bij afwezigheid wordt de server geraadpleegd (indien online).
   */
  async getSmartDocument(collectionName, docId) {
    let doc = await this.db.data
      .where({ collection: collectionName, _id: docId })
      .first();

    if (!doc && navigator.onLine) {
      try {
        doc = await this.gateway.getDocument(collectionName, docId);
        // Sla direct op in cache voor toekomstig offline gebruik
        await this.db.data.put({ ...doc, collection: collectionName });
      } catch (err) {
        console.error("Document niet gevonden op server:", err);
      }
    }
    return doc;
  }

  /**
   * Slaat een document op (nieuw of wijziging).
   * Werkt volgens het 'Optimistic UI' principe: direct lokaal succesvol, sync op de achtergrond.
   */
  async saveSmartDocument(collectionName, data) {
    // 1. Sla direct lokaal op in de cache (inclusief eventuele binaire Blobs)
    await this.db.data.put({ ...data, collection: collectionName });

    // 2. Voeg de actie toe aan de outbox (wachtrij)
    await this.db.outbox.add({
      action: 'SAVE',
      collection: collectionName,
      payload: data,
      timestamp: Date.now()
    });

    // 3. Probeer direct te synchroniseren
    this.syncOutbox();
    
    return { status: 'saved_locally', data };
  }

  /**
   * Verwijdert een document.
   */
  async deleteSmartDocument(collectionName, docId) {
    // 1. Verwijder lokaal
    await this.db.data.where({ collection: collectionName, _id: docId }).delete();

    // 2. Voeg toe aan outbox
    await this.db.outbox.add({
      action: 'DELETE',
      collection: collectionName,
      payload: { _id: docId },
      timestamp: Date.now()
    });

    this.syncOutbox();
  }

  /**
   * Wist de gehele collectie lokaal en zet een opdracht in de wachtrij voor de server.
   * @param {string} collectionName - De naam van de collectie (zonder prefix).
   */
  async clearSmartCollection(collectionName) {
    // 1. Directe visuele feedback: Wis alle lokale data voor deze collectie in Dexie
    await this.db.data.where({ collection: collectionName }).delete();

    // 2. Voeg de CLEAR actie toe aan de outbox voor synchronisatie met de MongoDB server
    await this.db.outbox.add({
      action: 'CLEAR',
      collection: collectionName,
      payload: null,
      timestamp: Date.now()
    });

    // 3. Probeer de wijziging direct naar de server te sturen
    this.syncOutbox();
  }

  /**
   * Verwerkt de wachtrij van wijzigingen en stuurt deze naar de API Gateway.
   */
  async syncOutbox() {
    if (!navigator.onLine) return;

    const pending = await this.db.outbox.toArray();
    if (pending.length === 0) return;

    for (const item of pending) {
      try {
        if (item.action === 'SAVE') {
          let finalPayload = { ...item.payload };

          // Scan op binaire velden en converteer naar Base64 voor de JSON API
          for (const key in finalPayload) {
            if (finalPayload[key] instanceof Blob || finalPayload[key] instanceof File) {
              finalPayload[key] = await this._blobToBase64(finalPayload[key]);
            }
          }

          await this.gateway.saveDocument(item.collection, finalPayload);
        } 
        else if (item.action === 'DELETE') {
          await this.gateway.deleteDocument(item.collection, item.payload._id);
        }
        else if (item.action === 'CLEAR') {
          // Roep de clearCollection methode aan van de DataGateway
          await this.gateway.clearCollection(item.collection);
        }

        // Verwijder uit de wachtrij bij succes
        await this.db.outbox.delete(item.id);
      } catch (err) {
        console.error("Synchronisatiefout voor item:", item, err);
        break; // Stop de loop bij netwerkfouten
      }
    }
  }

  /**
   * Ververst de volledige lokale cache voor een collectie vanuit MongoDB.
   */
  async refreshCache(collectionName) {
    try {
      const freshData = await this.gateway.getCollection(collectionName);
      
      // Verwijder oude cache data voor deze specifieke collectie
      await this.db.data.where({ collection: collectionName }).delete();
      
      // Voeg de nieuwe data toe met de collectie-tag
      const taggedData = freshData.map(d => ({ ...d, collection: collectionName }));
      await this.db.data.bulkAdd(taggedData);
      
      console.log(`Cache ververst voor: ${this.appName}_${collectionName}`);
    } catch (err) {
      console.warn("Kon cache niet verversen:", err);
    }
  }
}
