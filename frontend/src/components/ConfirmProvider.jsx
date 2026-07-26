import React, { createContext, useCallback, useContext, useState } from 'react';

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null);

  const confirm = useCallback((message) => {
    return new Promise((resolve) => {
      setRequest({ message, resolve });
    });
  }, []);

  const settle = (result) => {
    request?.resolve(result);
    setRequest(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <div className="modal-overlay" onClick={() => settle(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <p style={{ margin: '0 0 20px', fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-line' }}>{request.message}</p>
            <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => settle(false)}>Cancel</button>
              <button className="btn-primary btn-danger-solid" onClick={() => settle(true)} autoFocus>OK</button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmProvider');
  return ctx;
}
