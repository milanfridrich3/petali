// A short deny-list of the passwords attackers try first. This is a floor, not a breach check:
// checking against a breached-password corpus is a possible later addition (see docs).
export const COMMON_PASSWORDS = new Set([
  // 1.5.0 Phase 6: the minimum length dropped from 10 to 7, so the length rule no longer catches the 7-9 character passwords attackers try first.
  '1234567', '12345678', '123456789', '7654321', '87654321', '987654321', '11111111', '111111111', '1111111', '00000000', '000000000', '0000000',
  '12341234', '123123123', '12121212', '1q2w3e4', '1q2w3e4r', '1qaz2wsx', '1qazxsw2', 'zaq12wsx', '12qwaszx', 'q1w2e3r4', 'q1w2e3r4t', '123qweasd',
  'qazwsxedc', 'qwertyu', 'qwertyui', 'qwertyuio', 'qwerty1', 'qwerty12', 'qwerty123', 'qwerty1234', 'asdfghj', 'asdfghjk', 'zxcvbnm', 'zxcvbnm1',
  'abcd1234', 'abc1234', 'abc12345', 'abc123456', 'abcdefg', 'abcdefgh', 'abcdefghi', 'aaaaaaa', 'aaaaaaaa', 'passwor', 'password!', 'password2',
  'pa55word', 'p4ssword', 'pass1234', 'passw0rd1', 'pass123', 'pass12345', 'admin123', 'admin1234', 'letmein', 'letmein1', 'letmein12', 'welcome',
  'welcome1', 'welcome12', 'iloveyou', 'iloveyou1', 'iloveyou2', 'monkey1', 'monkey12', 'monkey123', 'dragon1', 'dragon12', 'dragon123', 'football',
  'football1', 'baseball', 'baseball1', 'superman', 'superman1', 'sunshine', 'sunshine1', 'princess', 'princess1', 'trustno1', 'master12', 'master123',
  'shadow12', 'shadow123', 'michael1', 'jordan23', 'freedom', 'whatever', 'starwars', 'computer', 'internet', 'samsung1', 'changeme1', 'secret1',
  'heslo123', 'heslo1234', 'heslo12', 'ahoj1234', 'ahojahoj', 'ahoj123', 'cesko123', 'praha123', 'brno1234', 'milan123', 'petali1', 'petali12', 'petali123',
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  '1234567890', '12345678910', '123456789012', '0123456789', '1q2w3e4r5t', '1qaz2wsx3edc', 'qwertyuiop', 'qwerty12345',
  'qwerty123456', 'qwertyuiop123', 'asdfghjkl', 'asdfghjkl123', 'zxcvbnm123', 'iloveyou123', 'letmein123', 'welcome123',
  'welcome1234', 'admin12345', 'administrator', 'changeme123', 'changeme', 'trustno1234', 'monkey12345', 'dragon12345',
  'football123', 'baseball123', 'superman123', 'princess123', 'sunshine123', 'master12345', 'shadow12345', 'michael123',
  'abc1234567', 'abcdefghij', 'abcd123456', 'aaaaaaaaaa', 'heslo12345', 'heslo123456', 'petali1234', 'petali12345',
  'petaliapp', 'petali123', 'internet123', 'computer123', 'whatever123', 'starwars123', 'passwordpassword', 'qazwsxedcrfv',
]);
