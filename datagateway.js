/**
 * DataGateway Client
 * Een universele JavaScript wrapper voor de Python MongoDB API Gateway.
 * Aangepast voor App-prefixing en geoptimaliseerd voor gebruik met OfflineManager.
 */
export default class DataGateway {
  /**
   * Initialiseert de gateway verbinding.
   * @param {string} baseUrl - De volledige URL naar de API.
   * @param {string} clientId - De unieke identificatie van de client.
   * @param {string} appName - De naam van de applicatie (voor collectie-prefixing).
   */
  constructor(baseUrl, clientId, appName) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    this.clientId = clientId;
    this.appName = appName;
  }

  /**
   * Hulpmethode om de collectienaam te voorzien van de app-prefix.
   * @private
   */
  _getPrefixedName(collectionName) {
    return `${this.appName}_${collectionName}`;
  }

  /**
   * Genereert de standaard headers voor elk verzoek.
   * @private
   */
  _getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-client-id': this.clientId
    };
  }

  /**
   * Verwerkt de API response en gooit een foutmelding bij problemen.
   * @private
   */
  async _handleResponse(response) {
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `API Fout: ${response.status}`);
    }
    return response.json();
  }

  /**
   * Haalt alle documenten op uit een collectie.
   */
  async getCollection(collectionName) {
    const fullPath = this._getPrefixedName(collectionName);
    const response = await fetch(`${this.baseUrl}/api/${fullPath}`, {
      method: 'GET',
      headers: this._getHeaders()
    });
    return this._handleResponse(response);
  }

  /**
   * Haalt één specifiek document op via ID.
   */
  async getDocument(collectionName, docId) {
    const fullPath = this._getPrefixedName(collectionName);
    const response = await fetch(`${this.baseUrl}/api/${fullPath}/${docId}`, {
      method: 'GET',
      headers: this._getHeaders()
    });
    return this._handleResponse(response);
  }

  /**
   * Slimme bewaarfunctie: Kiest automatisch tussen POST (nieuw) of PUT (update).
   * Controleert op aanwezigheid van '_id' of 'id'.
   */
  async saveDocument(collectionName, data) {
    const fullPath = this._getPrefixedName(collectionName);
    const docId = data._id || data.id;
    
    const url = docId 
      ? `${this.baseUrl}/api/${fullPath}/${docId}`
      : `${this.baseUrl}/api/${fullPath}`;

    const response = await fetch(url, {
      method: docId ? 'PUT' : 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify(data)
    });
    return this._handleResponse(response);
  }

  /**
   * Verwijdert een document permanent uit de database.
   */
  async deleteDocument(collectionName, docId) {
    const fullPath = this._getPrefixedName(collectionName);
    const response = await fetch(`${this.baseUrl}/api/${fullPath}/${docId}`, {
      method: 'DELETE',
      headers: this._getHeaders()
    });
    return this._handleResponse(response);
  }



/**
   * NIEUW: Wist de gehele collectie voor deze client.
   * Stuurt een DELETE verzoek naar het collectie-endpoint zonder ID.
   */
  async clearCollection(collectionName) {
    const fullPath = this._getPrefixedName(collectionName);
    const response = await fetch(`${this.baseUrl}/api/${fullPath}`, {
      method: 'DELETE',
      headers: this._getHeaders()
    });
    return this._handleResponse(response);
  }
}
