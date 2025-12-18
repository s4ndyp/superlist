/**
 * OfflineManager V3 - Samengevoegde Versie
 * Beheert lokale Dexie database, binaire bijlagen, Smart Clear en ID-koppeling.
 */
import DataGateway from './datagateway.js';

export default class OfflineManager {
  /**
   * @param {string} baseUrl - De URL van de API Gateway.
   * @param {string} clientId - De unieke ID van de gebruiker.
   * @param {string} appName - De naam van de applicatie.
   */
  constructor(baseUrl, clientId, appName) {
    this.appName = appName;
    this.gateway = new DataGateway(baseUrl, clientId, appName);
    
    // Unieke database per app en gebruiker
    this.db = new Dexie(`AppCache_${appName}_${clientId}`);
    
    // Schema definitie - Versie 4 voor de nieuwe ID koppeling logica
    this.db.version(4).stores({
      data: "++id, collection, _id", 
      outbox: "++id, action, collection, payload"
    });
  }

  /**
   * Hulpmethode om binaire bestanden (Blob/File) om te zetten naar Base64.
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
   * Slaat een document intelligent op.
   * Handelt binaire data af en voorkomt ID-conflicten.
   */
  async saveSmartDocument(collectionName, data) {
    const serverId = data._id || null;
    const action = serverId ? 'PUT' : 'POST';

    // 1. Optimistic UI: Sla direct lokaal op
    if (serverId) {
      const existing = await this.db.data
        .where({ collection: collectionName, _id: serverId })
        .first();
      
      if (existing) {
        await this.db.data.update(existing.id, { ...data, collection: collectionName });
      } else {
        await this.db.data.add({ ...data, collection: collectionName, _id: serverId });
      }
    } else {
      // Nieuw lokaal item zonder server _id
      await this.db.data.add({ ...data, collection: collectionName });
    }

    // 2. Voeg toe aan outbox voor sync
    await this.db.outbox.add({
      action: action,
      collection: collectionName,
      payload: data,
      timestamp: Date.now()
    });

    if (navigator.onLine) {
      this.syncOutbox();
    }

    return data;
  }

  /**
   * Synchroniseert de outbox met de server.
   * Inclusief Base64 conversie en ID-koppeling.
   */
  async syncOutbox() {
    if (!navigator.onLine) return;

    const items = await this.db.outbox.orderBy('id').toArray();
    
    for (const item of items) {
      try {
        let finalPayload = JSON.parse(JSON.stringify(item.payload));

        // Converteer eventuele Files/Blobs naar Base64
        for (const key in finalPayload) {
          if (finalPayload[key] instanceof File || finalPayload[key] instanceof Blob) {
            finalPayload[key] = await this._blobToBase64(finalPayload[key]);
          }
        }

        if (item.action === 'POST') {
          const response = await this.gateway.saveDocument(item.collection, finalPayload);
          // Koppel het nieuwe server ID aan het lokale record om duplicaten te voorkomen
          if (response && response._id) {
            await this._linkServerId(item.collection, item.payload, response._id);
          }
        } 
        else if (item.action === 'PUT') {
          await this.gateway.updateDocument(item.collection, item.payload._id, finalPayload);
        }
        else if (item.action === 'DELETE') {
          await this.gateway.deleteDocument(item.collection, item.payload._id);
        }
        else if (item.action === 'CLEAR') {
          await this.gateway.clearCollection(item.collection);
        }

        // Verwijder uit de wachtrij bij succes
        await this.db.outbox.delete(item.id);
      } catch (err) {
        console.error("Synchronisatiefout voor item:", item, err);
        break; // Stop bij netwerkfouten
      }
    }
  }

  /**
   * Interne methode om server _id's terug te schrijven naar lokale records.
   * @private
   */
  async _linkServerId(collectionName, originalPayload, newServerId) {
    // Zoek het lokale record dat nog geen _id heeft maar wel dezelfde unieke kenmerken (zoals naam)
    const localRecord = await this.db.data
      .where({ collection: collectionName })
      .filter(doc => !doc._id && (doc.name === originalPayload.name))
      .first();

    if (localRecord) {
      await this.db.data.update(localRecord.id, { _id: newServerId });
    }
  }

  /**
   * Haalt data op en filtert duplicaten (safety check).
   */
  async getSmartCollection(collectionName) {
    let localData = await this.db.data.where({ collection: collectionName }).toArray();
    
    // Filter duplicaten uit de array voor de UI
    const seen = new Set();
    localData = localData.filter(item => {
      const identifier = item._id || `local-${item.id}`;
      if (seen.has(identifier)) return false;
      seen.add(identifier);
      return true;
    });

    if (navigator.onLine) {
      this.refreshCache(collectionName);
    }
    return localData;
  }

  /**
   * Ververst de volledige lokale cache vanuit MongoDB.
   */
  async refreshCache(collectionName) {
    try {
      const freshData = await this.gateway.getCollection(collectionName);
      
      // Verwijder oude cache, behalve items die nog in de outbox staan (niet-gesyncte wijzigingen)
      const outboxItems = await this.db.outbox.where({ collection: collectionName }).toArray();
      const outboxIds = new Set(outboxItems.map(i => i.payload._id).filter(id => id));

      await this.db.data.where({ collection: collectionName })
        .filter(doc => !outboxIds.has(doc._id))
        .delete();
      
      const taggedData = freshData.map(d => ({ ...d, collection: collectionName }));
      await this.db.data.bulkPut(taggedData);
    } catch (err) {
      console.warn("Cache refresh mislukt:", err);
    }
  }

  /**
   * Voegt een CLEAR actie toe aan de outbox voor de hele collectie.
   */
  async clearSmartCollection(collectionName) {
    // Lokaal direct legen
    await this.db.data.where({ collection: collectionName }).delete();
    
    // Toevoegen aan outbox
    await this.db.outbox.add({
      action: 'CLEAR',
      collection: collectionName,
      timestamp: Date.now()
    });

    if (navigator.onLine) {
      this.syncOutbox();
    }
  }
}
