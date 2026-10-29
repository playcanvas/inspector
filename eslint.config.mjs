import javascriptConfig from '@playcanvas/eslint-config/javascript';
import globals from 'globals';

export default [
    ...javascriptConfig,
    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.node,
                Ammo: 'readonly'
            }
        },
        rules: {
            'import/order': 'off'
        }
    }
];
