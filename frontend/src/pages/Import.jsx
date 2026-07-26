import React, { useEffect, useState } from 'react';
import {
  importFromCurl, importPostmanCollection, importPostmanEnv, importDotenv, getFolders,
} from '../api/client';
import FilePicker from '../components/FilePicker.jsx';
import { useToast } from '../components/ToastProvider.jsx';

export default function Import() {
  const showToast = useToast();
  const [folders, setFolders] = useState([]);

  const [curl, setCurl] = useState('');
  const [curlName, setCurlName] = useState('');
  const [curlFolderId, setCurlFolderId] = useState('');
  const [curlResult, setCurlResult] = useState(null);
  const [curlLoading, setCurlLoading] = useState(false);
  const [curlError, setCurlError] = useState('');

  const [collectionText, setCollectionText] = useState('');
  const [collectionResult, setCollectionResult] = useState(null);
  const [collectionLoading, setCollectionLoading] = useState(false);
  const [collectionError, setCollectionError] = useState('');

  const [dotenvText, setDotenvText] = useState('');
  const [dotenvName, setDotenvName] = useState('');

  useEffect(() => {
    getFolders('endpoint').then(setFolders);
  }, []);

  const handleImportCurl = async () => {
    setCurlLoading(true);
    setCurlError('');
    try {
      const data = await importFromCurl({
        curl,
        name: curlName || undefined,
        folder_id: curlFolderId ? Number(curlFolderId) : null,
      });
      setCurlResult(data);
      showToast(`Endpoint "${data.endpoint.name}" imported successfully.`);
    } catch (err) {
      setCurlError(err.response?.data?.error || err.message);
    } finally {
      setCurlLoading(false);
    }
  };

  const handleImportCollection = async () => {
    setCollectionLoading(true);
    setCollectionError('');
    try {
      const collection = JSON.parse(collectionText);
      const data = await importPostmanCollection({ collection });
      setCollectionResult(data);
      getFolders('endpoint').then(setFolders);
      showToast(`${data.imported} endpoint(s) imported successfully.`);
    } catch (err) {
      setCollectionError(err.message.includes('JSON') ? 'File is not valid JSON' : (err.response?.data?.error || err.message));
    } finally {
      setCollectionLoading(false);
    }
  };

  const handleCollectionFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setCollectionText(await file.text());
  };

  const handlePostmanEnvFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const json = JSON.parse(await file.text());
    await importPostmanEnv(json);
    showToast('Environment imported successfully.');
  };

  const handleDotenvImport = async () => {
    await importDotenv({ name: dotenvName, content: dotenvText });
    setDotenvText('');
    setDotenvName('');
    showToast('Environment imported successfully.');
  };

  return (
    <div>
      <div className="page-header">
        <h3>Import</h3>
        <p>Bring in endpoints from cURL or a Postman Collection, and environments from Postman/.env — all from one place.</p>
      </div>

      <div className="card">
        <h4>Import from cURL</h4>
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <input
            placeholder="Endpoint name (optional)"
            value={curlName}
            onChange={(e) => setCurlName(e.target.value)}
            style={{ flex: 1 }}
          />
          <select value={curlFolderId} onChange={(e) => setCurlFolderId(e.target.value)}>
            <option value="">No Folder</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <textarea
          placeholder="Paste curl command here..."
          value={curl}
          onChange={(e) => setCurl(e.target.value)}
          rows={6}
          className="mono"
          style={{ width: '100%' }}
        />
        <div className="toolbar" style={{ marginTop: 10 }}>
          <button className="btn-primary" onClick={handleImportCurl} disabled={curlLoading || !curl}>
            {curlLoading ? 'Processing...' : 'Parse & Import'}
          </button>
        </div>
        {curlError && <p className="error-text">{curlError}</p>}
        {curlResult && (
          <div style={{ marginTop: 14 }}>
            <p style={{ color: 'var(--text)' }}>Endpoint created: <b>{curlResult.endpoint.method}</b> <span className="mono">{curlResult.endpoint.path_template}</span></p>
            <span className="field-label">Suggested assertions (reference for Flow steps)</span>
            <pre className="json-block">{JSON.stringify(curlResult.suggested_assertions, null, 2)}</pre>
          </div>
        )}
      </div>

      <div className="card">
        <h4>Import Postman Collection</h4>
        <p className="subtitle" style={{ marginTop: -4, marginBottom: 10 }}>
          Every request in the collection becomes a new endpoint; folders inside the collection are automatically recreated as matching folders.
        </p>
        <div style={{ marginBottom: 10 }}>
          <FilePicker accept=".json" onFileSelect={handleCollectionFile} label="Choose Collection File" />
        </div>
        <textarea
          placeholder="...or paste the collection.json content here"
          value={collectionText}
          onChange={(e) => setCollectionText(e.target.value)}
          rows={4}
          className="mono"
          style={{ width: '100%' }}
        />
        <div className="toolbar" style={{ marginTop: 10 }}>
          <button className="btn-primary" onClick={handleImportCollection} disabled={collectionLoading || !collectionText}>
            {collectionLoading ? 'Processing...' : 'Import Collection'}
          </button>
        </div>
        {collectionError && <p className="error-text">{collectionError}</p>}
        {collectionResult && <p style={{ color: 'var(--pass)' }}>{collectionResult.imported} endpoint(s) imported successfully.</p>}
      </div>

      <div className="card">
        <h4>Import Environment</h4>
        <span className="field-label">From Postman Environment (.json)</span>
        <div style={{ marginBottom: 16 }}>
          <FilePicker accept=".json" onFileSelect={handlePostmanEnvFile} label="Choose Environment File" />
        </div>

        <span className="field-label">From .env file</span>
        <input
          placeholder="Environment name"
          value={dotenvName}
          onChange={(e) => setDotenvName(e.target.value)}
          style={{ marginBottom: 8, width: '100%' }}
        />
        <textarea
          placeholder="Paste .env content here"
          value={dotenvText}
          onChange={(e) => setDotenvText(e.target.value)}
          rows={4}
          className="mono"
          style={{ width: '100%' }}
        />
        <div className="toolbar" style={{ marginTop: 10 }}>
          <button className="btn-primary" onClick={handleDotenvImport} disabled={!dotenvName || !dotenvText}>Import</button>
        </div>
      </div>
    </div>
  );
}
